const fs = require('fs');
const origReadFileSync = fs.readFileSync;
fs.readFileSync = function(path, ...args) {
  try {
    return origReadFileSync.call(fs, path, ...args);
  } catch (err) {
    if (err && err.code === 'EPERM' && String(path).includes('package.json')) {
      const enoent = new Error('ENOENT: no such file or directory, open ' + path);
      enoent.code = 'ENOENT';
      enoent.errno = -2;
      enoent.syscall = 'open';
      enoent.path = path;
      throw enoent;
    }
    throw err;
  }
};
