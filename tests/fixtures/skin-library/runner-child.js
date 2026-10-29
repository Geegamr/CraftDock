const mode = process.argv[2];
if (mode === 'timeout') {
  setTimeout(() => process.stdout.write('[]'), 11000);
} else if (mode === 'near-timeout') {
  setTimeout(() => process.stdout.write('[]'), 9000);
} else if (mode === 'oversize') {
  process.stdout.write(' '.repeat(64 * 1024 * 1024 + 1));
} else if (mode === 'oversize-stderr') {
  process.stderr.write('x'.repeat(64 * 1024 * 1024 + 1));
} else if (mode === 'limit-output') {
  process.stdout.write('[]' + ' '.repeat(64 * 1024 * 1024 - 2));
} else {
  process.stdout.write('[]');
}
