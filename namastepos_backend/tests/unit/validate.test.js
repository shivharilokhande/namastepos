// Verifies the QA-4 strict-mode behaviour of the Joi validator.

const Joi = require('joi');
const validate = require('../../src/middleware/validate');

function runMiddleware(mw, req) {
  return new Promise((resolve) => {
    mw(req, {}, (err) => resolve({ err, req }));
  });
}

describe('validate middleware (strict)', () => {
  const schema = { body: Joi.object({ name: Joi.string().required() }) };
  const mw = validate(schema);

  test('passes known fields', async () => {
    const { err, req } = await runMiddleware(mw, { body: { name: 'Cafe Latte' } });
    expect(err).toBeFalsy();
    expect(req.body.name).toBe('Cafe Latte');
  });

  test('rejects unknown fields (QA-4)', async () => {
    const { err } = await runMiddleware(mw, {
      body: { name: 'Cafe Latte', secretAdminFlag: true },
    });
    expect(err).toBeTruthy();
    // The wrapper turns Joi's "is not allowed" detail into the outer
    // "Validation failed" message — but the details array should still
    // mention the offending key.
    const details = err.details || err.payload?.details || [];
    expect(JSON.stringify(details)).toMatch(/secretAdminFlag/);
  });

  test('rejects missing required fields', async () => {
    const { err } = await runMiddleware(mw, { body: {} });
    expect(err).toBeTruthy();
  });
});
