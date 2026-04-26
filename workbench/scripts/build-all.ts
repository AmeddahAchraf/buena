import { buildAll } from "../lib/build-all";

(async () => {
  const r = await buildAll();
  console.log(JSON.stringify(r, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
