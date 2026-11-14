# លំហូរការងារនៃ Agentic Harness (ភាសាខ្មែរ)

ឯកសារនេះពន្យល់លំហូរការងាររបស់ harness ជាភាសាខ្មែរ។ ព័ត៌មានលម្អិតជាភាសាអង់គ្លេសមាននៅក្នុង `docs/WORKFLOW.md` និង `AGENTS.md`។

## ១. Harness ជាអ្វី?

Harness គឺជាកម្មវិធីគ្រប់គ្រង (controller) ដែលសរសេរដោយ Node.js សុទ្ធ ដោយមិនត្រូវការ package ណាមួយ។ វាដំណើរការ AI CLI ដូចជា Claude, `agy` ឬ Codex ឱ្យធ្វើការតាមជំហាន ហើយពិនិត្យលទ្ធផលដោយ test ពិតប្រាកដ មិនមែនជឿតាមពាក្យរបស់ AI ទេ។

## ២. វដ្តការងារសំខាន់

```
1_PLANNER → 2_EXECUTOR_SWARM → 3_VERIFIER → 4_COMMITTED
      ↑______ error ត្រូវបញ្ជូនត្រឡប់ (អតិបរមា ៣ ដង) ______|  បន្ទាប់មក HALTED_HITL_REQUIRED
```

- **PLANNER៖** បំបែកការងារជាផ្នែកតូចៗ ហើយកំណត់ថាឯកសារណាជារបស់ worker ណា។
- **EXECUTOR៖** worker ធ្វើការ ដោយកែបានតែឯកសារដែលបានកំណត់ឱ្យខ្លួនប៉ុណ្ណោះ។
- **VERIFIER៖** រត់ check ពិតប្រាកដ ដូចជា `npm test`។ បើបរាជ័យ error នឹងត្រូវបញ្ជូនទៅ worker វិញ ឱ្យជួសជុល។
- **COMMITTED៖** ការងារត្រូវបានទទួលយក លុះត្រាតែ test ឆ្លងកាត់។
- បើបរាជ័យដល់ ៣ ដង harness នឹងឈប់ ស្តារឯកសារទាំងអស់ឱ្យដូចដើមវិញ ហើយរង់ចាំអ្នកសម្រេចចិត្ត។

## ៣. របៀបដំណើរការ ៤ យ៉ាង

- **Normal** (`npm run run`)៖ worker តែមួយ សម្រាប់ការងារតូច ១ ឬ ២ ឯកសារ ហើយសន្សំ token ច្រើនជាងគេ។
- **Parallel** (`--mode parallel`)៖ worker ច្រើនធ្វើការក្នុងពេលតែមួយ ហើយម្នាក់ៗកាន់ឯកសារផ្សេងគ្នា។
- **Team** (`--mode team`)៖ orchestrator ចែកការងារទៅ lead (BA, DEV, QA) ហើយ lead ចែកបន្តទៅ worker។
- **Autopilot** (`npm run auto`)៖ ធ្វើការងារក្នុង backlog ដោយខ្លួនឯង ហើយរក្សាលទ្ធផលនៅលើ branch `uat` មិនមែន `main` ទេ។

## ៤. ក្នុង Claude Code (`/harness:run` និង `/harness:auto`)

- AI ក្នុង editor ធ្វើតួជា **orchestrator**៖ វាគ្រាន់តែរៀបចំផែនការ និងចែកការងារ ដោយមិនកែឯកសារ project ខ្លួនឯងទេ។
- **ជំហានទី១ `brief`៖** controller (`node .harness/visible.mjs`) ផ្តល់ task, check, និងសិទ្ធិរបស់ lead នីមួយៗ។
- **ជំហានទី២ `assign`៖** controller ពិនិត្យថាការចែកការងារត្រឹមត្រូវ និងមិននៅក្រៅសិទ្ធិ។
- **ជំហានទី៣៖** agent ដូចជា `lead-ba`, `lead-dev`, `lead-qa` ធ្វើការ ហើយអ្នកអាចមើលឃើញពួកវាធ្វើការ។
- **ជំហានទី៤ `verify`៖** controller ស្តារការកែប្រែណាដែលនៅក្រៅការចាត់តាំង ហើយរត់ check ពិតប្រាកដ។
- **ជំហានទី៥៖** orchestrator រាយការណ៍ជូនអ្នក។ វានិយាយថា "PASSED" លុះត្រាតែ controller និយាយដូច្នោះ។

## ៥. ការជ្រើសរើស engine

- `auto` ជ្រើស engine ដំបូងក្នុង `autoOrder` (antigravity → claude → codex) ដែលបានដំឡើងរួច ហើយ flag របស់វាឆ្លងកាត់ការពិនិត្យ `--help`។
- បើ engine ណាមិនរួចរាល់ harness នឹងប្តូរទៅ engine បន្ទាប់ ហើយកត់ត្រា `ENGINE_FALLBACK` ក្នុង `.harness/telemetry.log`។
- `node .harness/doctor.mjs` ពិនិត្យសុខភាពនៃការរៀបចំទាំងមូល។
- ព័ត៌មានលម្អិតអំពី engine មាននៅក្នុង `docs/ENGINES.md`។

## ៦. ច្បាប់សុវត្ថិភាព

- **Charter** (`.harness/charter.md`)៖ កំណត់ថា agent ស្វ័យប្រវត្តិអាចកែបានតែ `src/**`, `docs/**`, `tests/**`, `test/**` ប៉ុណ្ណោះ ហើយហាមកែ `.harness/**`។
- **Memory** (`.harness/memory/`)៖ `profile.md` និង `lessons.md` ត្រូវបានអានដោយ AI គ្រប់ៗ។ ឧទាហរណ៍ ច្បាប់ L1 តម្រូវឱ្យសួរម្ចាស់ project មុនរាល់ពេល push។
- **Rollback៖** បើការងារបរាជ័យ ឯកសារទាំងអស់ត្រូវបានស្តារមកដូចដើមវិញដោយស្វ័យប្រវត្តិ។
- AI មិនដែល push ឬ merge ទៅ `main` ដោយគ្មានការអនុញ្ញាតពីម្ចាស់ project ទេ។
- **ឧបករណ៍ AI នីមួយៗត្រូវអនុញ្ញាតម្តង** (`node .harness/engines.mjs`)៖ harness មិនប្រើឧបករណ៍ដែលបាន login ដោយស្ងាត់ៗទេ។
- **ការងារធំសួរមុន** (របៀប team ឬ parallel, workers ៣+, model កម្រិតខ្ពស់)។ ក្នុង autopilot វាត្រូវផ្អាកជា «ត្រូវការការយល់ព្រមពីអ្នក» ហើយការងារផ្សេងបន្ត។ យល់ព្រមដោយ `node .harness/backlog.mjs approve <id>`។
- **កំណត់ប្រចាំថ្ងៃ និងរបាយការណ៍ប្រើប្រាស់**៖ `config.json` → `dailyLimits` និង `node .harness/usage.mjs`។

## ៧. ឧទាហរណ៍ពិត

- **ការប៉ុនប៉ងដំបូង៖** test បរាជ័យ ៧៥/៨៩ ព្រោះ `sandbox()` ក្នុង `test/run-tests.mjs` បានចម្លង backlog និង run ដែលកំពុងបើក។
- **ការបញ្ឈប់៖** harness មិនអនុញ្ញាតឱ្យកែឯកសារនៅក្រៅការចាត់តាំងទេ ដូច្នេះការងារត្រូវបាន rollback ហើយម្ចាស់ project ត្រូវបានសួរ។
- **ការជួសជុលទី១៖** `sandbox()` ត្រូវបានជួសជុល ដើម្បីកុំឱ្យចម្លង backlog និង run ដែលកំពុងបើក។ test ឆ្លងកាត់ ៨៨/៨៩។
- **ការជួសជុលទី២៖** test ចុងក្រោយដែលនៅបរាជ័យ (demo project) ប្រើ `install.mjs` ដែលក៏បានចម្លង run ដែលកំពុងបើកដែរ។ `install.mjs` ត្រូវបានជួសជុលដោយមានការអនុញ្ញាត រួចចាប់ផ្តើម run ថ្មី។
- **លទ្ធផល៖** controller បាននិយាយថា PASSED ដោយ test ឆ្លងកាត់ ៨៩/៨៩។

នេះហើយជាគោលការណ៍ "Deterministic Verification"៖ test ពិតប្រាកដជាអ្នកសម្រេច មិនមែន AI ទេ។

## ៨. ការកែលម្អបន្ថែម

- test មិនខូចទៀតទេ ពេលមានការងារក្នុង backlog ឬមាន run កំពុងបើក (`sandbox()` ក្នុង `test/run-tests.mjs`)។
- ការដំឡើងថ្មី (`install.mjs`) មិនចម្លង profile, lessons, backlog ឬ run ដែលកំពុងបើក របស់ម្ចាស់ project ទៀតទេ។
- `agy` ទទួល prompt តាម stdin (`-p ""`)។ នៅលើ Windows harness រក្សា argument ទទេ `""` ដោយមិនបាត់។
- engine ដែល `--help` ទទេ ហើយ profile មិនទាន់ verified នឹងមិនត្រូវបានប្រើទេ។ probe cache មាន version ដូច្នេះលទ្ធផលចាស់មិនត្រូវបានប្រើឡើងវិញ។
- `doctor` ព្រមានពេល engine ដែលជ្រើសទីមួយមិនទាន់ដំឡើង។
- សារ "profile មិនទាន់បំពេញ" ដែលខុស ត្រូវបានជួសជុល៖ ឥឡូវពិនិត្យតែបន្ទាត់ field ដែលចាប់ផ្តើមដោយ `- ` ប៉ុណ្ណោះ។
