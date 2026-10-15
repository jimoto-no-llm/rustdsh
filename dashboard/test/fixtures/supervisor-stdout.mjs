import fs from "node:fs";

const [written, exited] = process.argv.slice(2),
  output = Buffer.alloc(4 * 1024 * 1024, 0x61);
process.on("exit", () => fs.writeFileSync(exited, "exited"));
process.stdout.write(output, (error) => {
  if (error) process.exitCode = 1;
  else fs.writeFileSync(written, "written");
});
