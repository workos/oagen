<?php

namespace WorkOS\Exception;

class BaseRequestException extends \Exception
{
    /**
     * @var string|null
     */
    public $requestId;

    /**
     * @param string $message
     * @param null|string $requestId
     * @param int $code
     */
    public function __construct($message = "", $requestId = null, $code = 0)
    {
        parent::__construct($message, $code);
        $this->requestId = $requestId;
    }

    /**
     * Get the request ID.
     *
     * @return string|null
     */
    public function getRequestId()
    {
        return $this->requestId;
    }
}
