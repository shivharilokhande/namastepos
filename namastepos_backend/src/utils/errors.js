// NamastePOS backend - typed error classes

class HttpError extends Error {
  constructor(statusCode, message, code, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code || 'INTERNAL_ERROR';
    this.details = details;
  }
}

class BadRequest extends HttpError {
  constructor(message = 'Bad request', details) {
    super(400, message, 'BAD_REQUEST', details);
  }
}

class Unauthorized extends HttpError {
  constructor(message = 'Unauthorized') {
    super(401, message, 'UNAUTHORIZED');
  }
}

class Forbidden extends HttpError {
  constructor(message = 'Forbidden') {
    super(403, message, 'FORBIDDEN');
  }
}

class NotFound extends HttpError {
  constructor(message = 'Not found') {
    super(404, message, 'NOT_FOUND');
  }
}

class Conflict extends HttpError {
  constructor(message = 'Conflict', details) {
    super(409, message, 'CONFLICT', details);
  }
}

class TooManyRequests extends HttpError {
  constructor(message = 'Too many requests') {
    super(429, message, 'RATE_LIMITED');
  }
}

module.exports = {
  HttpError, BadRequest, Unauthorized, Forbidden, NotFound, Conflict, TooManyRequests,
};
