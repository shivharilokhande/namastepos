// NamastePOS backend — bcrypt shim.
//
// Loads native `bcrypt` when its .node binding matches the current
// platform, otherwise falls back to pure-JS `bcryptjs`. Hash formats
// are identical between the two, so existing password_hash columns
// keep working regardless of which library actually generated them.
//
// Use this everywhere instead of `require('bcrypt')` — that way if
// someone forgets to rebuild the native binding after a platform swap
// (Docker image on Linux, dev on macOS) the app doesn't crash at
// require time.

let impl;
try {
  impl = require('bcrypt');
  // Force loading the .node file — if it was compiled for another
  // arch we get "invalid ELF header" here rather than at first hash.
  impl.getRounds(impl.hashSync('probe', 4));
} catch (_) {
  impl = require('bcryptjs');
}
module.exports = impl;
