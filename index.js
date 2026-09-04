const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');

http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const messageHistory = {};

async function generateWithRetry(modelName, prompt, retries = 3) {
  const model = genAI.getGenerativeModel({ model: modelName });

  for (let i = 0; i < retries; i++) {
    try {
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (e) {
      if (i === retries - 1) throw e;

      const delay = (i + 1) * 3000;

      console.log(
        `Спроба ${i + 1} не вдалась, чекаю ${delay / 1000}с...`
      );

      await new Promise(res => setTimeout(res, delay));
    }
  }
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

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption;

  if (!text || text.startsWith('/')) return;

  if (!messageHistory[chatId]) {
    messageHistory[chatId] = [];
  }

  messageHistory[chatId].push(
    `${msg.from.first_name}: ${text}`
  );
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const command = query.data;

  await bot.answerCallbackQuery(query.id);

  bot.emit('text', {
    ...query.message,
    text: `/${command}`,
    chat: { id: chatId },
    from: query.from
  });
});

async function handleCommand(
  chatId,
  command,
  waitMsg,
  successPrefix,
  promptText
) {
  const history = messageHistory[chatId];

  if (!history || history.length === 0) {
    return bot.sendMessage(
      chatId,
      '📭 Немає повідомлень. Перешли щось і спробуй знову.'
    );
  }

  bot.sendMessage(chatId, waitMsg);

  try {
    const text = await generateWithRetry(
      'gemini-3.8-flash',
      promptText
    );

    messageHistory[chatId] = [];

    bot.sendMessage(
      chatId,
      `${successPrefix}\n\n${text}`
    );
  } catch (e) {
    console.error(e);

    bot.sendMessage(
      chatId,
      '❌ Помилка. Спробуй ще раз:',
      retryKeyboard(command)
    );
  }
}

bot.onText(/\/digest/, (msg) => {
  const chatId = msg.chat.id;
  const history = messageHistory[chatId];

  const prompt = `Зроби короткий дайджест цих повідомлень. Відповідай українською мовою. Використовуй простий текст БЕЗ markdown, без зірочок, без решіток. Використовуй емодзі для структури. Формат:
🔹 Головні теми — перелічи теми
🔸 Висновки — 2-3 речення

${(history || []).join('\n')}`;

  handleCommand(
    chatId,
    'digest',
    '⏳ Аналізую...',
    '📋 Дайджест:',
    prompt
  );
});

bot.onText(/\/tldr/, (msg) => {
  const chatId = msg.chat.id;
  const history = messageHistory[chatId];

  const prompt = `Підсумуй ці повідомлення у 3 коротких речення. Тільки найголовніше. Без зайвих слів. Відповідай українською.

${(history || []).join('\n')}`;

  handleCommand(
    chatId,
    'tldr',
    '⏳ Стискаю до мінімуму...',
    '⚡ TL;DR:',
    prompt
  );
});

bot.onText(/\/topics/, (msg) => {
  const chatId = msg.chat.id;
  const history = messageHistory[chatId];

  const prompt = `Виділи список головних тем з цих повідомлень. Кожна тема — один рядок з емодзі. Без пояснень і висновків. Відповідай українською.

${(history || []).join('\n')}`;

  handleCommand(
    chatId,
    'topics',
    '⏳ Виділяю теми...',
    '🗂 Теми:',
    prompt
  );
});

bot.onText(/\/casualties/, async (msg) => {
  const chatId = msg.chat.id;
  const history = messageHistory[chatId];

  if (!history || history.length === 0) {
    return bot.sendMessage(
      chatId,
      '📭 Немає повідомлень. Перешли щось і спробуй знову.'
    );
  }

  bot.sendMessage(chatId, '⏳ Рахую втрати...');

  try {
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

${history.join('\n')}`;

    const raw = await generateWithRetry(
      "gemini-3.8-flash",
      prompt
    );

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

    const msg =
`⚔️ Втрати серед цивільних: Загалом ${zahynulo(totalDead)} ${totalDead} ${osoby(totalDead)}, з них ${totalDeadChildren} ${dytyny(totalDeadChildren)}. Поранення отримали ${totalInjured} ${osoby(totalInjured)}, з них ${totalInjuredChildren} ${dytyny(totalInjuredChildren)}, внаслідок ворожих атак у ${regions.length} ${plural(regions.length, "області", "областях", "областях")} (${regionNames}).

По областях (загиблі/поранені):
${regionList}

Не враховано:
${excludedList}`;

    messageHistory[chatId] = [];

    bot.sendMessage(chatId, msg);

  } catch (err) {
    console.error(err);

    bot.sendMessage(
      chatId,
      "❌ Помилка під час аналізу. Спробуйте ще раз.",
      retryKeyboard("casualties")
    );
  }
});

console.log('Bot started!');
