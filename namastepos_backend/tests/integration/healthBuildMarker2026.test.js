// DEPLOY VERIFIABILITY — /health + /v1/health build marker (2026-09-05)
//
// The bug was not a crash. /v1/health answered
//   {"status":"ok","service":"namastepos-api","version":"1.0.0","db":"ok",...}
// on EVERY deploy this service has ever had, because `version` is
// package.json's and nothing else in the response (or in any header) changed
// between builds. After pushing a commit the only way to find out whether
// Render had actually rolled it out was to log into the Render dashboard —
// so no script, no uptime monitor and no agent could verify a deploy.
//
// What these tests lock down:
//
//   1. the commit field is THERE and correct when the platform var is set
//   2. it degrades to the string "unknown" when the var is absent — always
//      present, never thrown, never inconsistently omitted (local dev, jest,
//      CI all live in this branch)
//   3. a value that is not a plausible SHA is NOT echoed back — this is a
//      public endpoint and must not become an env-var reader
//   4. /v1/health still makes exactly ONE DB round-trip (the pre-existing
//      health_db_ping()), and /health still makes ZERO. UptimeRobot hits
//      /v1/health every 5 minutes; the marker must be free.
//   5. /health and /v1/health agree — a memory note says the two handlers
//      differ, and they do (deep vs shallow), but not about which build is
//      running.
//
// This suite stubs db.query rather than migrating a schema, for two reasons:
// it is the only way to count round-trips exactly (which is half the point),
// and it lets us assert the DEGRADED path — a wedged pool must still tell you
// which build is wedged. It also keeps the suite off the shared Postgres,
// which is at its connection ceiling with 78 DB-backed suites already.

const request = require('supertest');
require('../setup'); // env defaults (NODE_ENV/JWT_SECRET/DATABASE_URL) only
const buildApp = require('../../src/app');
const db = require('../../src/config/db');

let app;

const FULL_SHA = 'efe5691a3c4d5e6f70819a2b3c4d5e6f70819a2b'; // 40 hex
const SHORT = 'efe5691';

/** Snapshot + clear every var buildInfo can read, so each test starts clean. */
const VARS = ['RENDER_GIT_COMMIT', 'RENDER_GIT_BRANCH', 'GIT_COMMIT', 'GIT_BRANCH'];
let saved = {};
let dbSpy;

beforeAll(() => {
  app = buildApp();
});

beforeEach(() => {
  saved = {};
  for (const k of VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // A healthy pool by default. Individual tests override for the wedged case.
  dbSpy = jest.spyOn(db, 'query').mockResolvedValue({ rows: [{ now: new Date().toISOString() }] });
});

afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  jest.restoreAllMocks();
});

describe('GET /v1/health — deployed commit is visible', () => {
  it('reports the short SHA and branch from the vars Render injects', async () => {
    process.env.RENDER_GIT_COMMIT = FULL_SHA;
    process.env.RENDER_GIT_BRANCH = 'main';

    const r = await request(app).get('/v1/health');

    expect(r.status).toBe(200);
    expect(r.body.commit).toBe(SHORT);
    expect(r.body.branch).toBe('main');
    // The old fields must survive — UptimeRobot and the keep-alive worker
    // key off `status`, and Sentry releases off `version`.
    expect(r.body.status).toBe('ok');
    expect(r.body.service).toBe('namastepos-api');
    expect(r.body.db).toBe('ok');
    expect(typeof r.body.version).toBe('string');
  });

  it('accepts an already-short SHA and lower-cases an upper-case one', async () => {
    process.env.RENDER_GIT_COMMIT = 'EFE5691';
    const r = await request(app).get('/v1/health');
    expect(r.body.commit).toBe(SHORT);
  });

  it('falls back to GIT_COMMIT / GIT_BRANCH off Render', async () => {
    process.env.GIT_COMMIT = FULL_SHA;
    process.env.GIT_BRANCH = 'release/1.2';
    const r = await request(app).get('/v1/health');
    expect(r.body.commit).toBe(SHORT);
    expect(r.body.branch).toBe('release/1.2');
  });

  it('prefers RENDER_GIT_COMMIT when both are set', async () => {
    process.env.RENDER_GIT_COMMIT = FULL_SHA;
    process.env.GIT_COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const r = await request(app).get('/v1/health');
    expect(r.body.commit).toBe(SHORT);
  });

  it('still identifies the build when the DB is wedged (503 degraded)', async () => {
    process.env.RENDER_GIT_COMMIT = FULL_SHA;
    dbSpy.mockRejectedValue(new Error('pool exhausted'));

    const r = await request(app).get('/v1/health');

    expect(r.status).toBe(503);
    expect(r.body.status).toBe('degraded');
    expect(r.body.db).toBe('down');
    // The whole point: you can tell WHICH build is unhealthy.
    expect(r.body.commit).toBe(SHORT);
  });
});

describe('GET /v1/health — degrades honestly with no env var', () => {
  it('reports "unknown" rather than throwing or dropping the field', async () => {
    // No RENDER_GIT_COMMIT — this is local dev, jest and CI.
    const r = await request(app).get('/v1/health');

    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('commit');
    expect(r.body.commit).toBe('unknown');
    expect(r.body.branch).toBe('unknown');
    expect(r.body.status).toBe('ok'); // still healthy, just unidentified
  });

  it('reports "unknown" for an empty or whitespace value', async () => {
    process.env.RENDER_GIT_COMMIT = '   ';
    process.env.RENDER_GIT_BRANCH = '';
    const r = await request(app).get('/v1/health');
    expect(r.body.commit).toBe('unknown');
    expect(r.body.branch).toBe('unknown');
  });
});

describe('GET /v1/health — does not leak environment content', () => {
  it('refuses to echo a value that is not a plausible SHA', async () => {
    // Anything from a fat-fingered env var to a deliberate injection.
    for (const bad of [
      '/opt/render/project/src',
      'srv-d2abc123def456',
      'postgres://user:pass@host/db',
      'zzzzzzz',
      'abc', // too short to be a git short SHA
    ]) {
      process.env.RENDER_GIT_COMMIT = bad;
      // eslint-disable-next-line no-await-in-loop
      const r = await request(app).get('/v1/health');
      expect(r.body.commit).toBe('unknown');
      expect(JSON.stringify(r.body)).not.toContain(bad);
    }
  });

  it('refuses a branch name with characters git refs cannot contain', async () => {
    process.env.RENDER_GIT_BRANCH = 'main; DATABASE_URL=$DATABASE_URL';
    const r = await request(app).get('/v1/health');
    expect(r.body.branch).toBe('unknown');
  });

  it('exposes exactly the intended keys and nothing else', async () => {
    process.env.RENDER_GIT_COMMIT = FULL_SHA;
    process.env.RENDER_GIT_BRANCH = 'main';
    const r = await request(app).get('/v1/health');
    expect(Object.keys(r.body).sort()).toEqual([
      'branch', 'commit', 'db', 'service', 'startedAt',
      'status', 'timestamp', 'uptimeSeconds', 'version',
    ]);
  });
});

describe('GET /v1/health — a restart is visible', () => {
  it('carries a process start time and an uptime', async () => {
    const before = Date.now();
    const r = await request(app).get('/v1/health');

    expect(typeof r.body.startedAt).toBe('string');
    const started = Date.parse(r.body.startedAt);
    expect(Number.isNaN(started)).toBe(false);
    expect(started).toBeLessThanOrEqual(before);

    expect(typeof r.body.uptimeSeconds).toBe('number');
    expect(r.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('keeps startedAt stable across calls within one process', async () => {
    const a = await request(app).get('/v1/health');
    const b = await request(app).get('/v1/health');
    expect(b.body.startedAt).toBe(a.body.startedAt);
  });
});

describe('health endpoints stay cheap', () => {
  it('/v1/health makes exactly ONE DB round-trip — the marker added none', async () => {
    const r = await request(app).get('/v1/health');

    expect(r.status).toBe(200);
    expect(dbSpy).toHaveBeenCalledTimes(1);
    expect(dbSpy.mock.calls[0][0]).toMatch(/health_db_ping/);
  });

  it('/health makes NO DB round-trip at all', async () => {
    const r = await request(app).get('/health');

    expect(r.status).toBe(200);
    expect(dbSpy).not.toHaveBeenCalled();
  });

  it('the response stays small enough for a 5-minutely probe', async () => {
    process.env.RENDER_GIT_COMMIT = FULL_SHA;
    process.env.RENDER_GIT_BRANCH = 'main';
    const r = await request(app).get('/v1/health');
    expect(JSON.stringify(r.body).length).toBeLessThan(400);
  });
});

describe('/health and /v1/health agree about the build', () => {
  it('shallow probe carries the same marker as the deep one', async () => {
    process.env.RENDER_GIT_COMMIT = FULL_SHA;
    process.env.RENDER_GIT_BRANCH = 'main';

    const shallow = await request(app).get('/health');
    const deep = await request(app).get('/v1/health');

    expect(shallow.status).toBe(200);
    expect(shallow.body.commit).toBe(SHORT);
    expect(shallow.body.commit).toBe(deep.body.commit);
    expect(shallow.body.branch).toBe(deep.body.branch);
    expect(shallow.body.startedAt).toBe(deep.body.startedAt);
    // ...and the shallow one is still shallow: no db key, no version.
    expect(shallow.body).not.toHaveProperty('db');
  });

  it('shallow probe also degrades to "unknown"', async () => {
    const r = await request(app).get('/health');
    expect(r.body.commit).toBe('unknown');
    expect(r.body.branch).toBe('unknown');
  });
});
