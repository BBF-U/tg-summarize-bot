const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');

http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
  console.error('[TELEGRAM POLLING ERROR]', {
    code: error?.code,
    message: error?.message,
    response: error?.response?.body
  });
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const messageHistory = {};
let nextHistoryId = 1;


const MODELS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite'
];

function getHttpStatus(error) {
  const directStatus = Number(
    error?.status ||
    error?.statusCode ||
    error?.response?.status
  );
  if (directStatus) return directStatus;

  const message = String(error?.message || '');
  const match = message.match(/\[(\d{3})(?:\s|\])/);
  return match ? Number(match[1]) : 0;
}

function isModelNotFoundError(error) {
  const status = getHttpStatus(error);
  const message = String(error?.message || '').toLowerCase();

  return status === 404 ||
    message.includes('model not found') ||
    message.includes('not supported for generatecontent') ||
    message.includes('does not exist');
}

function isTemporaryServerError(error) {
  const status = getHttpStatus(error);
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;

  const message = String(error?.message || '').toLowerCase();
  return (
    error?.name === 'TypeError' ||
    error?.name === 'AbortError' ||
    message.includes('fetch failed') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('network error') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('socket') ||
    message.includes('aborted') ||
    message.includes('abort')
  );
}

const REQUEST_TIMEOUT_MS = 45000;
const MODEL_RETRIES = 2;

async function generateWithRetry(prompt, retries = MODEL_RETRIES) {
  let lastError;

  for (const modelName of MODELS) {
    // RequestOptions.timeout is supported by the installed legacy SDK.
    const model = genAI.getGenerativeModel(
      { model: modelName },
      { timeout: REQUEST_TIMEOUT_MS }
    );

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(
          `GEMINI MODEL: ${modelName} | ATTEMPT: ${attempt}/${retries} | TIMEOUT: ${REQUEST_TIMEOUT_MS}ms`
        );

        const result = await model.generateContent(prompt);

        return {
          text: result.response.text(),
          model: modelName
        };
      } catch (error) {
        lastError = error;
        const status = getHttpStatus(error);

        console.error('GEMINI ERROR DETAILS:', {
          model: modelName,
          attempt,
          status: status || undefined,
          name: error?.name,
          message: error?.message,
          cause: error?.cause?.message,
          code: error?.cause?.code
        });

        // A missing/invalid model should skip retries for this model,
        // but must not prevent trying the next fallback model.
        if (isModelNotFoundError(error)) {
          console.error(`${modelName} not found/unsupported; switching to next model.`);
          break;
        }

        if (!isTemporaryServerError(error)) {
          // Authentication, permission, malformed prompt, and other non-transient
          // errors are unlikely to be fixed by switching models.
          throw error;
        }

        console.error(`${modelName} failed:`, status || error?.message);

        if (attempt < retries) {
          const delay = 5000 * attempt;
          console.log(`Retrying ${modelName} in ${delay / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    console.log(`${modelName} недоступна, переходжу до наступної моделі.`);
  }

  throw lastError || new Error('Усі моделі недоступні.');
}

const MAX_HISTORY_MESSAGES = 80;
const MAX_MESSAGE_CHARS = 2500;
const MAX_HISTORY_CHARS = 50000;
const activeCommands = new Set();

function collectMessage(msg) {
  const chatId = msg?.chat?.id;
  const text = msg?.text || msg?.caption;

  if (chatId == null || !text || text.startsWith('/')) return;

  if (!messageHistory[chatId]) messageHistory[chatId] = [];

  const author = msg.sender_chat?.title ||
    msg.from?.first_name ||
    msg.from?.username ||
    'Невідомий автор';

  messageHistory[chatId].push({
    id: nextHistoryId++,
    text: `${author}: ${String(text).slice(0, MAX_MESSAGE_CHARS)}`
  });

  // Bound both message count and total text size per chat.
  while (
    messageHistory[chatId].length > MAX_HISTORY_MESSAGES ||
    messageHistory[chatId].reduce((sum, item) => sum + item.text.length, 0) > MAX_HISTORY_CHARS
  ) {
    messageHistory[chatId].shift();
  }
}

function consumeHistory(chatId, snapshot) {
  const current = messageHistory[chatId] || [];
  if (!snapshot.length) return;

  const lastProcessedId = snapshot[snapshot.length - 1].id;
  // Keep all messages that arrived after this request's immutable snapshot.
  messageHistory[chatId] = current.filter(item => item.id > lastProcessedId);
}

function retryKeyboard(command) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Повторити', callback_data: command }]
      ]
    }
  };
}

bot.on('message', collectMessage);
bot.on('channel_post', collectMessage);

bot.on('callback_query', async (query) => {
  try {
    await bot.answerCallbackQuery(query.id);

    const command = String(query.data || '').replace(/^\//, '');
    if (!['digest', 'tldr', 'topics', 'casualties'].includes(command)) return;
    if (!query.message) return;

    // Re-process the button as a synthetic command message so onText handlers run.
    bot.processUpdate({
      update_id: Date.now(),
      message: {
        ...query.message,
        text: `/${command}`,
        from: query.from
      }
    });
  } catch (error) {
    console.error('[TELEGRAM CALLBACK ERROR]', error);
  }
});

async function handleCommand(
  chatId,
  command,
  waitMsg,
  successPrefix,
  promptText,
  historySnapshot
) {
  if (!historySnapshot || historySnapshot.length === 0) {
    return bot.sendMessage(
      chatId,
      '📭 Немає повідомлень. Перешли щось і спробуй знову.'
    );
  }

  if (activeCommands.has(chatId)) {
    return bot.sendMessage(chatId, '⏳ Уже обробляю попередню команду в цьому чаті. Дочекайся результату.');
  }

  activeCommands.add(chatId);
  try {
    await bot.sendMessage(chatId, waitMsg);
    const { text, model } = await generateWithRetry(promptText);

    consumeHistory(chatId, historySnapshot);
    await bot.sendMessage(
      chatId,
      `${successPrefix}\n\n${text}\n\n🤖 Модель: ${model}`
    );
  } catch (e) {
    console.error('[COMMAND ERROR]', command, e);
    await bot.sendMessage(
      chatId,
      '❌ Помилка. Спробуй ще раз:',
      retryKeyboard(command)
    );
  } finally {
    activeCommands.delete(chatId);
  }
}

bot.onText(/^\/digest(?:@\w+)?$/i, (msg) => {
  const chatId = msg.chat.id;
  const history = [...(messageHistory[chatId] || [])];

  const prompt = `Зроби короткий дайджест цих повідомлень. Відповідай українською мовою. Використовуй простий текст БЕЗ markdown, без зірочок, без решіток. Використовуй емодзі для структури. Формат:
🔹 Головні теми — перелічи теми
🔸 Висновки — 2-3 речення

${history.map(item => item.text).join('\n')}`;

  handleCommand(
    chatId,
    'digest',
    '⏳ Аналізую...',
    '📋 Дайджест:',
    prompt,
    history
  );
});

bot.onText(/^\/tldr(?:@\w+)?$/i, (msg) => {
  const chatId = msg.chat.id;
  const history = [...(messageHistory[chatId] || [])];

  const prompt = `Підсумуй ці повідомлення у 3 коротких речення. Тільки найголовніше. Без зайвих слів. Відповідай українською.

${history.map(item => item.text).join('\n')}`;

  handleCommand(
    chatId,
    'tldr',
    '⏳ Стискаю до мінімуму...',
    '⚡ TL;DR:',
    prompt,
    history
  );
});

bot.onText(/^\/topics(?:@\w+)?$/i, (msg) => {
  const chatId = msg.chat.id;
  const history = [...(messageHistory[chatId] || [])];

  const prompt = `Виділи список головних тем з цих повідомлень. Кожна тема — один рядок з емодзі. Без пояснень і висновків. Відповідай українською.

${history.map(item => item.text).join('\n')}`;

  handleCommand(
    chatId,
    'topics',
    '⏳ Виділяю теми...',
    '🗂 Теми:',
    prompt,
    history
  );
});

bot.onText(/^\/casualties(?:@\w+)?$/i, async (msg) => {
  const chatId = msg.chat.id;
  const history = [...(messageHistory[chatId] || [])];

  if (history.length === 0) {
    return bot.sendMessage(
      chatId,
      '📭 Немає повідомлень. Перешли щось і спробуй знову.'
    );
  }

  if (activeCommands.has(chatId)) {
    return bot.sendMessage(chatId, '⏳ Уже обробляю попередню команду в цьому чаті. Дочекайся результату.');
  }

  activeCommands.add(chatId);

  try {
    await bot.sendMessage(chatId, '⏳ Рахую втрати...');
    const prompt = `Роль: Ти — аналітик текстових зведень про обстріли.

Твоє завдання — визначити точну кількість загиблих та поранених цивільних по кожній області України.

АЛГОРИТМ ПІДРАХУНКУ:

1. Знайди всі повідомлення про загиблих і поранених цивільних.

2. Для кожної області визнач:
- які повідомлення описують окремі події;
- які повідомлення є повтором тієї самої події;
- які повідомлення є уточненням уже опублікованої інформації;
- які повідомлення входять до добового зведення.

3. ДОБОВІ ЗВЕДЕННЯ ОВА/МВА/ПРОКУРАТУРИ:

Знайди повідомлення зі словами:
- "за минулу добу"
- "упродовж доби"
- "за добу"
- "протягом доби"
- "минулої доби"

Такі зведення мають високий пріоритет, але НЕ означають автоматично, що всі інші повідомлення цієї області треба відкинути.

Добове зведення є основним підсумком лише за той період, який воно описує.

4. ВАЖЛИВО: НЕ ВВАЖАЙ АВТОМАТИЧНО ПІЗНІШЕ ПОВІДОМЛЕННЯ ДУБЛЕМ.

Якщо після добового зведення з'явилося оперативне повідомлення, спочатку визнач, чи йдеться про:

A) ту саму подію, яка вже врахована;
B) уточнення кількості постраждалих у тій самій події;
C) нову окрему подію.

Якщо це A або B → не додавай людей повторно.

Якщо це C → ОБОВ'ЯЗКОВО додай нових загиблих/поранених до підсумку.

Не відкидай оперативну новину лише тому, що для цієї області вже є добове зведення.

5. КОЛИ ВВАЖАТИ ПОВІДОМЛЕННЯ УТОЧНЕННЯМ:

Вважай нове повідомлення уточненням попереднього лише тоді, коли з тексту це прямо або однозначно випливає.

Наприклад:
- "уточнено кількість постраждалих";
- "раніше повідомлялося про 5, тепер відомо про 8";
- "кількість поранених зросла до...";
- описано ту саму конкретну подію, те саме місце та той самий удар, але кількість постраждалих стала відомою пізніше.

Якщо такого зв'язку немає — НЕ вигадуй, що це уточнення.

6. НЕ МОЖНА ВВАЖАТИ ДУБЛЕМ ЛИШЕ ЧЕРЕЗ:
- однакову область;
- однакове місто;
- однаковий день;
- те, що в обох повідомленнях є слово "постраждали";
- те, що вже існує добове зведення.

Одна область може мати кілька різних подій за один день, і їх потрібно рахувати окремо.

7. Якщо одна і та сама подія згадується декілька разів різними джерелами (ОВА, МВА, прокуратура, ДСНС, поліція, мер тощо) — рахуй її лише ОДИН раз.

Якщо цифри щодо тієї самої події відрізняються — використовуй найновішу підтверджену цифру.

Попередню цифру внеси до "excluded".

8. Київ є окремим регіоном і НЕ входить до Київської області.

9. УТОЧНЕННЯ В ДУБЛЬОВАНИХ ПОВІДОМЛЕННЯХ:

Якщо оперативне повідомлення є дублем події, яка вже врахована в добовому зведенні, НЕ додавай повторно загальну кількість загиблих або поранених.

АЛЕ інформацію з такого повідомлення можна використовувати для уточнення вже врахованої події, якщо вона не збільшує загальну кількість людей.

Це стосується будь-яких уточнень:
- кількості дітей;
- віку постраждалих;
- статі;
- кількості госпіталізованих;
- тяжкості травм;
- інших характеристик уже врахованих постраждалих.

Наприклад:

Добове зведення:
"52 людини отримали поранення."

Оперативне повідомлення:
"26 людей постраждали, серед них 3 дітей."

Якщо встановлено, що ці 26 людей входять до тих самих 52, тоді:
- injured = 52;
- injured_children = 3;
- 26 людей НЕ додаються повторно;
- 3 дітей НЕ додаються до загальної кількості поранених;
- інформація про 26 людей вважається частиною вже врахованих 52.

Інший приклад:

Добове зведення:
"52 людини отримали поранення."

Оперативне повідомлення:
"26 людей постраждали, серед них 18 чоловіків та 8 жінок."

Якщо це та сама подія, 26 людей НЕ додаються повторно. Загальна кількість залишається 52.

ВАЖЛИВО:
Інформацію з дубльованого повідомлення можна використовувати для уточнення характеристик уже врахованих людей, але НЕ можна додавати цих людей повторно до dead або injured.

10. Дітьми вважай усіх осіб віком ДО 18 років.

11. Кількість дітей НЕ МОЖНА ВИГАДУВАТИ.

Якщо прямо вказано конкретний вік — визначай дитину за віком.

Якщо прямо вказано "3 дітей" — записуй 3.

Якщо сказано "серед постраждалих є дитина" — це означає щонайменше 1 дитину.

Якщо точна кількість дітей не вказана, НЕ вигадуй точну кількість.

Якщо немає достатньо інформації для визначення кількості дітей — використовуй 0.

12. Не створюй область, якщо:
dead = 0
injured = 0
dead_children = 0
injured_children = 0

13. Один регіон = один запис.

14. Після підрахунку ОБОВ'ЯЗКОВО перевір:

- чи немає однакових областей;
- чи кожна окрема подія врахована лише один раз;
- чи не відкинута нова подія через наявність добового зведення;
- чи попередні цифри не були додані разом з остаточними;
- чи сума dead по областях дорівнює загальній кількості загиблих;
- чи сума injured по областях дорівнює загальній кількості поранених;
- чи сума dead_children по областях дорівнює загальній кількості загиблих дітей;
- чи сума injured_children по областях дорівнює загальній кількості поранених дітей;
- чи всі числа є цілими;
- чи всі числа >= 0.

15. НЕВРАХОВАНІ ПОВІДОМЛЕННЯ:

Якщо повідомлення НЕ включене до підсумку через:
- дублювання вже врахованої події;
- уточнення вже врахованої події;
- попередню цифру, яку замінила остаточна;
- іншу чітко визначену причину;

додай його до масиву "excluded".

Для кожного такого повідомлення вкажи:

- name — область;
- dead — кількість загиблих у неврахованому повідомленні;
- dead_children — кількість загиблих дітей, якщо відома;
- injured — кількість поранених у неврахованому повідомленні;
- injured_children — кількість поранених дітей, якщо відома;
- reason — коротка конкретна причина.

Дані з "excluded" НЕ входять до підсумку "regions".

Не додавай одне й те саме повідомлення до "excluded" більше одного разу.

16. ОСОБЛИВО ВАЖЛИВО:

НЕ використовуй правило "брати більшу цифру".

Більша цифра може стосуватися іншої події.

Спочатку визнач, чи це та сама подія.

Якщо це та сама подія — використовуй остаточну цифру.

Якщо це інша подія — додавай її окремо.

17. Якщо є сумнів, чи два повідомлення описують одну подію, проаналізуй:
- місце;
- час;
- тип удару;
- опис події;
- кількість і характеристики постраждалих;
- формулювання джерела.

Не об'єднуй події лише через недостатню інформацію.

ПОВЕРНИ ТІЛЬКИ ВАЛІДНИЙ JSON.

Структура:

{
  "regions": [
    {
      "name": "Київ",
      "dead": 9,
      "dead_children": 0,
      "injured": 33,
      "injured_children": 4
    }
  ],
  "excluded": [
    {
      "name": "Київська",
      "dead": 1,
      "dead_children": 0,
      "injured": 3,
      "injured_children": 0,
      "reason": "Повтор тієї самої події, остаточна цифра вже врахована"
    }
  ]
}

Якщо неврахованих повідомлень немає:

{
  "regions": [...],
  "excluded": []
}

Не додавай жодного тексту поза JSON.

${history.map(item => item.text).join('\n')}`;

    const { text: raw, model } = await generateWithRetry(prompt);

    const clean = raw
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    const parsed = JSON.parse(clean);

    if (!parsed.regions || !Array.isArray(parsed.regions)) {
      throw new Error("JSON не містить regions");
    }

    const excluded = Array.isArray(parsed.excluded)
      ? parsed.excluded
      : [];

    // Об'єднання однакових областей
    const map = new Map();

    for (const r of parsed.regions) {
      const name = String(r.name || '').trim();

      if (!name) continue;

      const dead = Number.isInteger(Number(r.dead))
        ? Number(r.dead)
        : 0;

      const deadChildren = Number.isInteger(Number(r.dead_children))
        ? Number(r.dead_children)
        : 0;

      const injured = Number.isInteger(Number(r.injured))
        ? Number(r.injured)
        : 0;

      const injuredChildren = Number.isInteger(Number(r.injured_children))
        ? Number(r.injured_children)
        : 0;

      if (!map.has(name)) {
        map.set(name, {
          name,
          dead,
          dead_children: deadChildren,
          injured,
          injured_children: injuredChildren
        });
      } else {
        const x = map.get(name);

        x.dead += dead;
        x.dead_children += deadChildren;
        x.injured += injured;
        x.injured_children += injuredChildren;
      }
    }

    const regions = [...map.values()]
      .filter(r =>
        r.dead > 0 ||
        r.injured > 0 ||
        r.dead_children > 0 ||
        r.injured_children > 0
      )
      .sort((a, b) =>
        a.name.localeCompare(b.name, "uk")
      );

    const totalDead =
      regions.reduce((s, r) => s + r.dead, 0);

    const totalDeadChildren =
      regions.reduce((s, r) => s + r.dead_children, 0);

    const totalInjured =
      regions.reduce((s, r) => s + r.injured, 0);

    const totalInjuredChildren =
      regions.reduce((s, r) => s + r.injured_children, 0);

    function plural(n, one, few, many) {
      const d10 = n % 10;
      const d100 = n % 100;

      if (d10 === 1 && d100 !== 11) {
        return one;
      }

      if (
        d10 >= 2 &&
        d10 <= 4 &&
        (d100 < 12 || d100 > 14)
      ) {
        return few;
      }

      return many;
    }

    const osoby = n =>
      plural(n, "особа", "особи", "осіб");

    const dytyny = n =>
      plural(n, "дитина", "дитини", "дітей");

    const zahynulo = n =>
      n === 1 ? "загинула" : "загинуло";

    function cleanRegionName(name) {
      return String(name)
        .replace(/\s+область$/i, "")
        .replace(/\s+обл\.?$/i, "")
        .trim();
    }

    const regionNames = regions
      .map(r => cleanRegionName(r.name))
      .join(", ");

    const regionList = regions
      .map(r => {
        const name = cleanRegionName(r.name);

        return `${name} — ${r.dead}/${r.injured}`;
      })
      .join("\n");

    const excludedList = excluded.length
      ? excluded
          .map(r => {
            const name = cleanRegionName(r.name);

            const dead = Number(r.dead) || 0;
            const deadChildren =
              Number(r.dead_children) || 0;

            const injured = Number(r.injured) || 0;
            const injuredChildren =
              Number(r.injured_children) || 0;

            return `• ${name} — ${dead}/${injured} (діти: ${deadChildren}/${injuredChildren}) — ${r.reason || 'Причина не вказана'}`;
          })
          .join("\n")
      : "Немає";

const kyivCapital = regions.some(r =>
  cleanRegionName(r.name).toLowerCase() === "київ"
);

const oblastCount = regions.filter(r =>
  cleanRegionName(r.name).toLowerCase() !== "київ"
).length;

const locationSummary = kyivCapital
  ? `у ${oblastCount} ${plural(oblastCount, "області", "областях", "областях")} та столиці Києві`
  : `у ${oblastCount} ${plural(oblastCount, "області", "областях", "областях")}`;

const msg =
`⚔️ Втрати серед цивільних: Загалом ${zahynulo(totalDead)} ${totalDead} ${osoby(totalDead)}, з них ${totalDeadChildren} ${dytyny(totalDeadChildren)}. Поранення отримали ${totalInjured} ${osoby(totalInjured)}, з них ${totalInjuredChildren} ${dytyny(totalInjuredChildren)}, внаслідок ворожих атак ${locationSummary} (${regionNames}).

По областях (загиблі/поранені):
${regionList}

Не враховано:
${excludedList}

🤖 Модель: ${model}`;

    consumeHistory(chatId, history);

    await bot.sendMessage(chatId, msg);

  } catch (err) {
    console.error(err);

    await bot.sendMessage(
      chatId,
      "❌ Помилка під час аналізу. Спробуйте ще раз.",
      retryKeyboard("casualties")
    );
  } finally {
    activeCommands.delete(chatId);
  }
});

console.log('Bot started!');
