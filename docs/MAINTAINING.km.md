# ការថែទាំ Agentic Harness

English version: [`MAINTAINING.md`](MAINTAINING.md).

## Lab, template និង projects

| | វាជាអ្វី | អ្នកណាកែ |
|---|---|---|
| **Lab**៖ branch `lab` នៃ repository នេះ | កន្លែងសាងសង់ និងសាកល្បង harness ពិតៗរាល់ថ្ងៃ | ម្ចាស់ (និង AI ដែលធ្វើការជាមួយគាត់) |
| **Template**៖ branch `release` នៃ repository នេះ | កំណែដែលបានសាករួច៖ អ្វីដែល `npx github:sumtaimo/Agentic-Harness#release` ដំឡើង និងអ្វីដែល landing page បង្ហាញ | គ្មាននរណាកែផ្ទាល់ទេ៖ lab ត្រូវបានចម្លងចូលវា ក្រោយពេលជាប់ការសាក និងមានការយល់ព្រមពីម្ចាស់ |
| **Projects** | repository ណាមួយដែលបានដំឡើង harness (របស់អ្នក ឬអ្នកផ្សេង) | តែ settings របស់ខ្លួនប៉ុណ្ណោះ៖ កូដស្នូលរបស់ harness ត្រូវបានការពារមិនឲ្យកែនៅទីនោះ |

ដូច្នេះការកែក្នុង lab មិនទៅដល់អ្នកប្រើដោយខ្លួនឯងទេ៖ វាទៅដល់ពួកគេ តែពេលម្ចាស់ចេញផ្សាយវាប៉ុណ្ណោះ។

មានការងារពីរ ហើយវាមិនលាយគ្នាទេ៖

| | **ប្រើ** harness | **ថែទាំ** harness |
|---|---|---|
| នៅឯណា | project ណាដែលបានដំឡើង harness (មាន `.harness/MANIFEST.json`) | repository template នេះ (មាន `install.mjs` និងឯកសារនេះ) |
| អ្នកណា | អ្នក ក្រុមរបស់អ្នក និង AI agents ដែលធ្វើការលើ project | ម្ចាស់ template (និង AI ដែលធ្វើការជាមួយគាត់នៅទីនេះ) |
| អាចកែ | settings របស់ project ផ្ទាល់៖ `config.json`, `charter.md`, `team.json`, `roles/`, `skills/`, `backlog.json`, `memory/` | អ្វីៗទាំងអស់ តាមបញ្ជីពិនិត្យខាងក្រោម |
| មិនត្រូវកែ | កូដស្នូលរបស់ harness៖ `.harness/*.mjs`, `.harness/lib/**`, `.harness/MANIFEST.json` | ច្បាប់របស់ម្ចាស់ (ខាងក្រោម) |

## របៀបការពារកូដស្នូលក្នុង project

- កម្មវិធីដំឡើងសរសេរ `.harness/MANIFEST.json`៖ ស្នាមម្រាមដៃ (fingerprint) នៃឯកសារស្នូលនីមួយៗ និងកំណែ template។
- `node .harness/doctor.mjs` ប្រៀបធៀបវា ហើយព្រមានពេលឯកសារស្នូលត្រូវបានកែ លុប ឬបន្ថែម។
- Claude Code ទទួលបានច្បាប់ហាម (deny) ក្នុង `.claude/settings.json` របស់ project ដូច្នេះ agents មិនអាចកែកូដស្នូលបានទេ។
- Hook ពេលចាប់ផ្តើម session និង `AGENTS.md` ប្រាប់ AI គ្រប់ៗ៖ ប្រើ harness កុំជួសជុលវា ត្រូវរាយការណ៍ចំណុចខ្វះជំនួសវិញ។
- Agents ស្វ័យប្រវត្តិមិនអាចសរសេរក្នុង `.harness/**` ពីមុនមកម្ល៉េះ (`forbiddenPaths` ក្នុង `charter.md`)។

Repository template មិនមានការហាមទាំងនេះទេ ដូច្នេះវាអាចត្រូវបានថែទាំបាន។

## ការរាយការណ៍ចំណុចខ្វះ (ពី project)

បើរកឃើញកំហុស ឬមុខងារខ្វះក្នុង harness ពេលកំពុងប្រើ កុំកែវានៅក្នុង project៖ ការកែនឹងបាត់នៅពេលធ្វើបច្ចុប្បន្នភាពលើកក្រោយ
ហើយ project ផ្សេងទៀតនឹងមិនទទួលបានវាទេ។ សូមបើក issue លើ template
(<https://github.com/sumtaimo/Agentic-Harness/issues>) ដោយដាក់៖

1. អ្វីដែលអ្នកបានរត់ អ្វីដែលរំពឹងទុក និងអ្វីដែលបានកើតឡើង
2. លទ្ធផលនៃ `node .harness/doctor.mjs`
3. កំណែ template (`"version"` ក្នុង `.harness/MANIFEST.json`)
4. សម្រាប់ការងារដែលបរាជ័យ៖ trace ក្នុង `.harness/failed/*.trace.txt` (លុបព័ត៌មានឯកជនចេញជាមុន)

ពេលការកែត្រូវបានចេញផ្សាយ ធ្វើបច្ចុប្បន្នភាព project៖ `npx github:sumtaimo/Agentic-Harness#release .`។ config, charter, team,
backlog និង memory របស់អ្នកត្រូវបានរក្សាទុក ចំណែកកូដស្នូល និងស្នាមម្រាមដៃរបស់វាត្រូវបានជំនួសថ្មី។

## បញ្ជីពិនិត្យមុនចេញផ្សាយ (សម្រាប់អ្នកថែទាំ)

រត់ទាំងនេះក្នុង repository template តាមលំដាប់។ គ្មានអ្វីទៅ `lab` ទេ លុះត្រាតែជាប់ទាំងអស់ **ហើយម្ចាស់យល់ព្រម**។

1. `npm test`៖ ឈុតតេស្តឥតគិតថ្លៃ (ប្រើតែ engine ក្លែង ហើយលាក់ឧបករណ៍ AI ពិតលើម៉ាស៊ីនរបស់អ្នក)។
2. `npm run audit -- --site`៖ ដំឡើងក្នុង project ទទេដូចអ្នកប្រើថ្មី ហើយពិនិត្យរាល់ពាក្យបញ្ជា ការយោងក្នុងឯកសារ
   ច្បាប់របស់ម្ចាស់ និងការ build website។ ឥតគិតថ្លៃ ព្រោះវាមិនដែលហៅឧបករណ៍ AI ទេ។
3. ការរត់ពិត៖ តែពេល command line ឬ models របស់ engine ផ្លាស់ប្តូរ ហើយតែពេលម្ចាស់យល់ព្រម (វាប្រើ quota)។
   ការងារតូចមួយក្នុង project សាកល្បង (`npm run demo` រួចការងារ `hello.txt` ក្នុង `docs/ENGINES.md`)។
4. បង្កើន `"version"` ក្នុង `package.json` ពេលកូដស្នូលផ្លាស់ប្តូរ (ការដំឡើងនីមួយៗកត់ត្រាវា)។
5. Commit លើ `lab` រួចសួរម្ចាស់មុន push។ Push ធម្មតាប៉ុណ្ណោះ។
6. **ចេញផ្សាយ**៖ ពេលកំណែក្នុង lab ត្រូវបានប្រើពិតរួច ហើយម្ចាស់និយាយថា «release» ចម្លងវាទៅ template៖
   `git push origin lab:release` (push ធម្មតា កុំ force)។ ចាប់ពីពេលនោះ អ្នកប្រើដែលដំឡើងពី `#release` និង landing page
   (ដែល deploy ពី `release`) ទទួលបានវា។ គ្មានអ្វីទៅដល់អ្នកប្រើមុនជំហាននេះទេ។

## ច្បាប់របស់ម្ចាស់

- សួរមុនរាល់ការ push មុនកែ `.harness/config.json` ឬ `.harness/charter.md` មុនដំឡើងកម្មវិធីសកល ឬបន្ថែម dependencies
  និងមុនអ្វីៗដែលចំណាយលុយ ឬ quota AI។
- កុំ force-push ឬសរសេរប្រវត្តិ `lab` ឬ `release` ឡើងវិញ ដោយគ្មានការយល់ព្រមច្បាស់សម្រាប់សកម្មភាពនោះជាក់លាក់។
- កុំចាប់ផ្តើម autonomous (`npm run auto`, `/harness:auto`) លុះត្រាតែមានការប្រាប់។
- គ្មានឈ្មោះ model ក្នុង commits, code comments ឬឯកសារ៖ វានៅតែក្នុង `.harness/config.json` ប៉ុណ្ណោះ
  (`npm run audit` ពិនិត្យវា ដោយប្រើឈ្មោះក្នុង config)។
- គ្មាន dependencies៖ ប្រើតែ Node standard library។
- គ្មានព័ត៌មានគណនី quota ឬការ login ផ្ទាល់ខ្លួន ក្នុង repository ឬក្នុងសារ commit។
- Engine ក្លាយជា `"verified": true` តែក្រោយការរត់ពិតជោគជ័យប៉ុណ្ណោះ ហើយ note របស់វាត្រូវប្រាប់ពីរបៀបដែលបានបញ្ជាក់។

## ការងារថែទាំញឹកញាប់

- **Model ត្រូវបានប្តូរឈ្មោះ ឬមាន model ថ្មី៖** រត់ `agy models` ឬ `codex debug models` ហើយកែ `profiles.<engine>.models`
  និង `quotaFallback.*.models` ក្នុង `config.json`។ បន្ទាប់មក `doctor` មិនត្រូវបង្ហាញ ID ដែលមិនស្គាល់ទៀតទេ។
  Claude Code ប្រើ alias ដូច្នេះមិនចាំបាច់កែទេ។
- **CLI ផ្លាស់ប្តូរ flags៖** រត់ `<tool> --help` (សម្រាប់ Codex៖ `codex exec --help`) ហើយកែ `args` ក្នុង profile។
  ការពិនិត្យ flags និង `doctor` បញ្ជាក់វា បន្ទាប់មកធ្វើការរត់ពិតតាមជំហានទី ៣។
- **បន្ថែម ឬដក engine៖** កែ profile ក្នុង `config.json`, `ROUTABLE_ENGINES` (និង `REMOVED_ENGINES` ពេលដកចេញ)
  ក្នុង `.harness/lib/common.mjs`, ច្បាប់ routing ក្នុង `.harness/lib/governance.mjs` និងច្បាប់ចម្លងរបស់វាក្នុង
  `website/src/lib/routing.ts`, តេស្ត, `docs/ENGINES.md` និងតារាង engine ក្នុង README។
- **ផ្លាស់ប្តូរ scope ឬតួនាទីក្នុង team៖** រត់ `node .harness/team.mjs validate` រួច `node .harness/team.mjs sync-agents`
  ដើម្បីឲ្យ agents ក្នុង Claude Code ត្រូវគ្នា។ Scope ប្រភេទឯកសារ (ដូចជា `src/**/*.test.*`) ជាម្ចាស់ឯកសាររបស់វា
  ទោះស្ថិតក្នុង scope ថតរបស់ lead ផ្សេង (ដូចជា `src/**`) ក៏ដោយ ដូច្នេះឯកសារនីមួយៗនៅតែមានម្ចាស់តែមួយ។
