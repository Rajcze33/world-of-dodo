// World of DODO, issue #31: the first module of the game's own import stage (main.ts imports it before anything else).
//
// The same mark as core/evalmark1.ts, one stage later: set, main.ts's code was downloaded and began to run (a failure after this
// threw); unset, it never came (entry.ts then asks for a reload). The loading screen's longest task (ui/loading.ts LOAD.longest) is
// measured from the end of this stage's evaluation (LOAD.t.code, entry.ts), not from here: that task is an import stage with its own
// budget, and whether it counted hung on a race between its start and this clock.
import { LOAD } from '../ui/loading';

window.WOD_EVAL = 3;
LOAD.t.eval3 = performance.now();
