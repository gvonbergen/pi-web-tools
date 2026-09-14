process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ ok: true, html: "<html><body><article><p>" + "界😀".repeat(100) + "</p></article></body></html>" })));
