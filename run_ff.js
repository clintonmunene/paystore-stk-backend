console.log("RUNNER starting, pid=" + process.pid);
try {
  const ff = require('@google-cloud/functions-framework');
  ff.start({
    target: 'stkPush',
    signatureType: 'http',
    port: 9090,
    host: '127.0.0.1'
  });
} catch (e) {
  console.error("runner error:", e && e.stack ? e.stack : e);
  process.exit(1);
}
