// Serves the production build (dist/) — used by `npm start`. Reads PORT
// from the environment (Railway, and most hosts, set this automatically),
// falling back to 3000 for local testing. A plain Node script instead of
// a shell one-liner because npm runs scripts through cmd.exe on Windows,
// not bash, so `$PORT`/`${PORT:-3000}` never gets interpreted there.
import { spawn } from "child_process";

const port = process.env.PORT || 3000;

spawn("npx", ["serve", "-s", "dist", "-l", `tcp://0.0.0.0:${port}`], {
  stdio: "inherit",
  shell: true,
});
