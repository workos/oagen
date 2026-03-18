class BaseRequestException(Exception):
    message: str
    request_id: str


class AuthorizationException(BaseRequestException):
    pass


class AuthenticationException(BaseRequestException):
    pass


class NotFoundException(BaseRequestException):
    pass
