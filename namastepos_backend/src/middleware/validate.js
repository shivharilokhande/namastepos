// NamastePOS backend - request validation middleware (Joi-backed)

const { BadRequest } = require('../utils/errors');

function validate(schemas) {
  return (req, _res, next) => {
    const errors = [];
    for (const part of ['body', 'query', 'params']) {
      if (!schemas[part]) continue;
      // P1 (Arvind #5): we previously silently dropped unknown fields. That
      // hid client bugs (typos in field names) AND meant any future addition
      // to a public Joi schema implicitly accepted arbitrary clients. Now we
      // reject unknown fields explicitly so the client gets a clear error.
      const { error, value } = schemas[part].validate(req[part], {
        abortEarly: false,
        stripUnknown: false,
        allowUnknown: false,
      });
      if (error) {
        errors.push(...error.details.map((d) => `${part}.${d.path.join('.')}: ${d.message}`));
      } else {
        req[part] = value;
      }
    }
    if (errors.length) return next(new BadRequest('Validation failed', errors));
    return next();
  };
}

module.exports = validate;
