<?php

// ini_set('display_errors', 1);
// error_reporting((E_ALL | E_STRICT) ^ E_NOTICE);

define('VARNISH_DEVELOPER_MODE', false);
define('VARNISH_GENERIC_CONTROLLER_VERSION', '0.0.1');

$currentUser = get_current_user();
$currentDirectory = sprintf('%s/', rtrim(dirname(__FILE__), '/'));
$settingsFile = sprintf('%s/settings.json', rtrim($currentDirectory, '/'));
$logDirectory = sprintf('/home/%s/logs/varnish-cache/', $currentUser);
$varnishPurgeLogfile = sprintf('%s/purge.log', rtrim($logDirectory, '/'));

class ClpVarnish
{
    private $enabled = false;
    private $developerMode = false;
    private $purgeLogfile = '';
    private $server = '';
    private $isCacheable = true;
    static private $cacheTagPrefix = '';
    static private $cacheLifetime = 0;
    static private $cacheTags = [];
    private $excludes = [];
    private $excludedParams = [];
    static private $queuedPurges = [];

    public function setEnabled($flag): void
    {
        $this->enabled = (bool)$flag;
    }

    public function isEnabled(): bool
    {
        return $this->enabled;
    }

    public function setDeveloperMode($flag): void
    {
        $this->developerMode = (bool)$flag;
    }

    public function isDeveloperMode(): bool
    {
        return $this->developerMode;
    }

    public function setPurgeLogfile($purgeLogfile): void
    {
        $this->purgeLogfile = $purgeLogfile;
    }

    public function getPurgeLogfile(): string
    {
        return $this->purgeLogfile;
    }

    static public function setCacheTagPrefix($cacheTagPrefix): void
    {
        self::$cacheTagPrefix = $cacheTagPrefix;
    }

    static public function getCacheTagPrefix(): string
    {
        return self::$cacheTagPrefix;
    }

    static public function setCacheLifetime($cacheLifetime): void
    {
        self::$cacheLifetime = $cacheLifetime;
    }

    static public function getCacheLifetime(): int
    {
        return self::$cacheLifetime;
    }

    static public function addCacheTag($cacheTag): void
    {
        self::$cacheTags[] = $cacheTag;
    }

    public function getCacheTags(): array
    {
        return self::$cacheTags;
    }

    public function setServer($server): void
    {
        $this->server = $server;
    }

    public function getServer(): ?string
    {
        return $this->server;
    }

    public function setExcludes(array $excludes): void
    {
        $this->excludes = $excludes;
    }

    public function getExcludes(): array
    {
        return $this->excludes;
    }

    public function setExcludedParams(array $excludedParams): void
    {
        $this->excludedParams = $excludedParams;
    }

    public function getExcludedParams(): array
    {
        return $this->excludedParams;
    }

    public function setIsCacheable($flag): void
    {
        $this->isCacheable = $flag;
    }

    public function isCacheable(): bool
    {
        if (true === $this->isCacheable) {
            $isEnabled = $this->isEnabled();
            if (false === $isEnabled) {
                return false;
            }
            $cacheLifetime = self::getCacheLifetime();
            if (0 === $cacheLifetime) {
                return false;
            }
            if (false === empty($_POST)) {
                return false;
            }
            $excludedParams = (array)$this->getExcludedParams();
            if (false === empty($excludedParams)) {
                foreach ($excludedParams as $excludedParam) {
                    if (true === isset($_GET[$excludedParam])) {
                        return false;
                    }
                }
            }
            $excludes = $this->getExcludes();
            $requestUri = (true === isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '');
            if (false === empty($excludes) && false === empty($requestUri)) {
                foreach ($excludes as $exclude) {
                    $exclude = trim($exclude);
                    if (true === isset($exclude[0]) && '^' == $exclude[0]) {
                        $exclude = substr($exclude, 1);
                        if (substr($requestUri, 0, strlen($exclude)) === $exclude) {
                            return false;
                        }
                    } else {
                        if (strpos($requestUri, $exclude) !== false) {
                            return false;
                        }
                    }
                }
            }
            return true;
        }
        return false;
    }

    public function addTagsToPurge(array $tags)
    {
        if (count($tags)) {
            foreach ($tags as $tag) {
                self::$queuedPurges['tags'][] = $tag;
            }
        }
    }

    private function purge(array $headers): void
    {
        try {
            $server = $this->getServer();
            $curlOptionList = [
                CURLOPT_URL               => $server,
                CURLOPT_HTTPHEADER        => $headers,
                CURLOPT_CUSTOMREQUEST     => 'PURGE',
                CURLOPT_VERBOSE           => true,
                CURLOPT_RETURNTRANSFER    => true,
                CURLOPT_NOBODY            => true,
                CURLOPT_CONNECTTIMEOUT_MS => 2000,
            ];
            $curlHandler = curl_init();
            curl_setopt_array($curlHandler, $curlOptionList);
            curl_exec($curlHandler);
            curl_close($curlHandler);
        } catch (\Exception $e) {
            $errorMessage = $e->getMessage();
            echo sprintf('Varnish Cache Purge Failed, Error Message: %s', $errorMessage);
        }
    }

    public function sendCacheHeaders(): void
    {
        $isCacheable = $this->isCacheable();
        if (true === $isCacheable) {
            $cacheTagPrefix = $this->getCacheTagPrefix();
            $cacheLifetime = $this->getCacheLifetime();
            $cacheTags = array_merge([$cacheTagPrefix], self::getCacheTags());
            $cacheTags = array_unique($cacheTags);
            if (count($cacheTags)) {
                header(sprintf('X-Cache-Lifetime: %s', $cacheLifetime));
                header(sprintf('X-Cache-Tags: %s', implode(',', $cacheTags)));
                header(sprintf('Pragma: %s', 'cache'));
                header(sprintf('Cache-Control: public, max-age=%s, s-maxage=%s', $cacheLifetime, $cacheLifetime));
            }
        }
    }

    public function shutdownPurge(): void
    {
        if (count(self::$queuedPurges)) {
            if (true === isset(self::$queuedPurges['tags']) && false === empty(self::$queuedPurges['tags'])) {
                $tags = array_filter(array_unique(self::$queuedPurges['tags']));
                $headers = [
                    sprintf('X-Cache-Tags: %s', implode(',', $tags))
                ];
                $this->purge($headers);
                $this->logPurge($tags);
            }
        }
    }

    private function logPurge(array $data)
    {
        $isDeveloperMode = $this->isDeveloperMode();
        if (true === $isDeveloperMode) {
            $dateTime = new \DateTime('now', new \DateTimeZone('UTC'));
            $logMessage = sprintf('%s, %s', $dateTime->format('Y-m-d H:i:s'), print_r($data, true));
            $purgeLogfile = $this->getPurgeLogfile();
            file_put_contents($purgeLogfile, $logMessage.PHP_EOL, FILE_APPEND | LOCK_EX);
        }
    }
}

if (true === file_exists($settingsFile)) {
    if (false === file_exists($logDirectory)) {
        @mkdir($logDirectory, 0770, true);
    }
    $settings = json_decode(file_get_contents($settingsFile), true);
    $varnishEnabled = (true === isset($settings['enabled']) && true === $settings['enabled'] ? true : false);
    $varnishServer = (true === isset($settings['server']) ? $settings['server'] : '');
    $varnishCacheTagPrefix = (true === isset($settings['cacheTagPrefix']) ? $settings['cacheTagPrefix'] : '');
    $varnishCacheLifetime = (true === isset($settings['cacheLifetime']) ? (int)$settings['cacheLifetime'] : 0);
    $varnishCacheExcludes = (true === isset($settings['excludes']) && true === is_array($settings['excludes']) ? $settings['excludes'] : []);
    $varnishCacheExcludedParams = (true === isset($settings['excludedParams']) && true === is_array($settings['excludedParams']) ? $settings['excludedParams'] : []);
    $clpVarnish = new ClpVarnish();
    $clpVarnish->setEnabled($varnishEnabled);
    $clpVarnish->setDeveloperMode(VARNISH_DEVELOPER_MODE);
    $clpVarnish->setPurgeLogfile($varnishPurgeLogfile);
    $clpVarnish->setServer($varnishServer);
    $clpVarnish->setCacheTagPrefix($varnishCacheTagPrefix);
    $clpVarnish->setCacheLifetime($varnishCacheLifetime);
    $clpVarnish->setExcludes($varnishCacheExcludes);
    $clpVarnish->setExcludedParams($varnishCacheExcludedParams);
    $headerRegisterCallback = function() use ($clpVarnish) {
        $cacheTagPrefix = $clpVarnish->getCacheTagPrefix();
        $clpVarnish->sendCacheHeaders();
    };
    $registerShutdownCallback = function() use ($clpVarnish) {
        $cacheTagPrefix = $clpVarnish->getCacheTagPrefix();
        $clpVarnish->shutdownPurge();
    };
    header_register_callback($headerRegisterCallback);
    register_shutdown_function($registerShutdownCallback);
}
