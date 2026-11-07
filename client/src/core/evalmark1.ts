// World of DODO, issue #31: the first module of the 3D engine's import stage (core/engine.ts imports it before Babylon).
//
// entry.ts imports core/engine.ts on its own (a stage), and a module graph runs only once all of it is downloaded. So when this
// line has run, the stage's code was downloaded and began to run: if the import fails afterwards, it threw (no WebGL: `new Engine`
// throws "WebGL not supported") and a reload would not help; if it fails with this unset, the code never came (the network, a
// deploy in between) and a reload may. It imports nothing that is not loaded already (ui/loading.ts is in the first script).
import { LOAD } from '../ui/loading';

window.WOD_EVAL = Math.max(window.WOD_EVAL ?? 0, 1);
LOAD.t.eval1 = performance.now();
