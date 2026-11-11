// The fixed lines an assistant says on a call, in each language it can speak (languages.ts): the default
// greeting, the AI note, goodbye, silence and limit lines, busy lines, quick tool replies and the keypad menu.
// Owner-written texts (greeting, closing line, recording notice) are kept as written; only when one is still
// the English default and the main language is another is it swapped for that language's default (localizedDefault).
import type { Language } from './languages.ts'

export type SpokenLines = {
  /** The default greeting; `ai`: with the AI note. */
  greeting: (business: string, name: string, ai: boolean) => string
  /** Said when the assistant has no greeting. */
  fallbackGreeting: string
  /** The sentence that says the assistant is an AI, put in a greeting that does not say it. */
  aiSentence: (name: string) => string
  /** Finds the AI note in a greeting already written in this language. */
  aiNote: RegExp
  /** Asked in place of the greeting's closing question when the caller must agree to talk with an AI. */
  consentQuestion: string
  /** Said to a returning caller before the greeting; `{first_name}` is filled in. */
  knownCaller: string
  goodbye: string
  stillThere: string
  callLimit: string
  testCallLimit: string
  silenceClosing: string
  busy: string
  overCap: string
  blocked: string
  messageSaved: string
  urgentFlagged: string
  recordingNotice: string
  keypadOption: (label: string, key: string) => string
  keypadEnd: string
  /** A key that is not on the keypad menu. */
  wrongKey: string
  /** After a second wrong key: no menu again, just talk. */
  justTellMe: string
}

const en: SpokenLines = {
  greeting: (b, n, ai) => `Thanks for calling ${b}. This is ${n}${ai ? ', the AI assistant' : ''}. How can I help?`,
  fallbackGreeting: 'Thanks for calling. How can I help?',
  aiSentence: n => `This is ${n}, the AI assistant.`,
  aiNote: /,?\s*(?:the|an|your|a)\s+(?:virtual|AI)\s+assistant\b/i,
  consentQuestion: 'Is that okay with you?',
  knownCaller: 'Hi {first_name}, good to hear from you again.',
  goodbye: 'Thanks for calling. Goodbye!',
  stillThere: 'Are you still there?',
  callLimit:
    "I'm sorry, we've reached the time limit for this call. I've noted everything for the team, and someone will get back to you. Goodbye!",
  testCallLimit: "This test call has reached its time limit, so I'll end it now. Goodbye!",
  silenceClosing: "I can't hear anyone on the line, so I'll hang up now. Please call us back anytime.",
  busy: 'Sorry, all our lines are busy right now. Please call back in a few minutes.',
  overCap: "Sorry, we can't take your call right now. We'll call you back as soon as we can.",
  blocked: "Sorry, we can't take your call. Goodbye.",
  messageSaved:
    "Thanks, I've passed your message on, and the team will get back to you. Is there anything else I can help with?",
  urgentFlagged:
    "I've marked this as urgent for the team. Is the number you're calling from the best way to reach you?",
  recordingNotice: 'This call may be recorded.',
  keypadOption: (label, key) => `For ${label}, press ${key}.`,
  keypadEnd: 'Or just tell me how I can help.',
  wrongKey: 'Sorry, that key is not on the menu.',
  justTellMe: 'Just tell me how I can help.',
}

const es: SpokenLines = {
  greeting: (b, n, ai) =>
    `Gracias por llamar a ${b}. Soy ${n}${ai ? ', asistente de IA' : ''}. ¿En qué puedo ayudarle?`,
  fallbackGreeting: 'Gracias por llamar. ¿En qué puedo ayudarle?',
  aiSentence: n => `Soy ${n}, asistente de IA.`,
  aiNote: /\bIA\b/,
  consentQuestion: '¿Le parece bien?',
  knownCaller: 'Hola {first_name}, qué gusto volver a saber de usted.',
  goodbye: 'Gracias por llamar. ¡Adiós!',
  stillThere: '¿Sigue ahí?',
  callLimit:
    'Lo siento, hemos llegado al tiempo máximo de esta llamada. He anotado todo para el equipo y alguien se pondrá en contacto con usted. ¡Adiós!',
  testCallLimit: 'Esta llamada de prueba ha llegado a su tiempo máximo, así que la termino ahora. ¡Adiós!',
  silenceClosing: 'No oigo a nadie en la línea, así que voy a colgar. Llámenos cuando quiera.',
  busy: 'Lo siento, todas nuestras líneas están ocupadas. Por favor, vuelva a llamar en unos minutos.',
  overCap: 'Lo siento, ahora no podemos atender su llamada. Le devolveremos la llamada lo antes posible.',
  blocked: 'Lo siento, no podemos atender su llamada. Adiós.',
  messageSaved:
    'Gracias, he pasado su mensaje y el equipo se pondrá en contacto con usted. ¿Puedo ayudarle en algo más?',
  urgentFlagged:
    'He marcado esto como urgente para el equipo. ¿El número desde el que llama es el mejor para localizarle?',
  recordingNotice: 'Esta llamada puede ser grabada.',
  keypadOption: (label, key) => `Para ${label}, pulse ${key}.`,
  keypadEnd: 'O simplemente dígame en qué puedo ayudarle.',
  wrongKey: 'Lo siento, esa tecla no está en el menú.',
  justTellMe: 'Simplemente dígame en qué puedo ayudarle.',
}

const fr: SpokenLines = {
  greeting: (b, n, ai) =>
    `Merci d'avoir appelé ${b}. Je suis ${n}${ai ? ', assistant IA' : ''}. Comment puis-je vous aider ?`,
  fallbackGreeting: "Merci d'avoir appelé. Comment puis-je vous aider ?",
  aiSentence: n => `Je suis ${n}, assistant IA.`,
  aiNote: /\bIA\b/,
  consentQuestion: 'Cela vous convient-il ?',
  knownCaller: 'Bonjour {first_name}, ravi de vous entendre à nouveau.',
  goodbye: "Merci d'avoir appelé. Au revoir !",
  stillThere: 'Vous êtes toujours là ?',
  callLimit:
    "Désolé, nous avons atteint la durée maximale de cet appel. J'ai tout noté pour l'équipe, et quelqu'un vous recontactera. Au revoir !",
  testCallLimit: 'Cet appel de test a atteint sa durée maximale, je vais donc y mettre fin. Au revoir !',
  silenceClosing: "Je n'entends personne sur la ligne, je vais donc raccrocher. N'hésitez pas à nous rappeler.",
  busy: 'Désolé, toutes nos lignes sont occupées pour le moment. Merci de rappeler dans quelques minutes.',
  overCap: 'Désolé, nous ne pouvons pas prendre votre appel pour le moment. Nous vous rappellerons dès que possible.',
  blocked: 'Désolé, nous ne pouvons pas prendre votre appel. Au revoir.',
  messageSaved:
    "Merci, j'ai transmis votre message et l'équipe vous recontactera. Puis-je vous aider pour autre chose ?",
  urgentFlagged:
    "J'ai signalé cet appel comme urgent à l'équipe. Le numéro depuis lequel vous appelez est-il le meilleur pour vous joindre ?",
  recordingNotice: 'Cet appel peut être enregistré.',
  keypadOption: (label, key) => `Pour ${label}, appuyez sur ${key}.`,
  keypadEnd: 'Ou dites-moi simplement comment je peux vous aider.',
  wrongKey: 'Désolé, cette touche ne fait pas partie du menu.',
  justTellMe: 'Dites-moi simplement comment je peux vous aider.',
}

const de: SpokenLines = {
  greeting: (b, n, ai) =>
    `Danke für Ihren Anruf bei ${b}. Hier ist ${n}${ai ? ', die KI-Assistenz' : ''}. Wie kann ich helfen?`,
  fallbackGreeting: 'Danke für Ihren Anruf. Wie kann ich helfen?',
  aiSentence: n => `Hier ist ${n}, die KI-Assistenz.`,
  aiNote: /\bKI\b/,
  consentQuestion: 'Ist das für Sie in Ordnung?',
  knownCaller: 'Hallo {first_name}, schön, wieder von Ihnen zu hören.',
  goodbye: 'Danke für Ihren Anruf. Auf Wiederhören!',
  stillThere: 'Sind Sie noch da?',
  callLimit:
    'Es tut mir leid, die maximale Gesprächsdauer ist erreicht. Ich habe alles für das Team notiert, und jemand meldet sich bei Ihnen. Auf Wiederhören!',
  testCallLimit: 'Dieser Testanruf hat seine maximale Dauer erreicht, deshalb beende ich ihn jetzt. Auf Wiederhören!',
  silenceClosing:
    'Ich höre niemanden in der Leitung, deshalb lege ich jetzt auf. Rufen Sie uns gerne jederzeit wieder an.',
  busy: 'Leider sind gerade alle Leitungen belegt. Bitte rufen Sie in ein paar Minuten wieder an.',
  overCap: 'Leider können wir Ihren Anruf gerade nicht annehmen. Wir rufen Sie so bald wie möglich zurück.',
  blocked: 'Leider können wir Ihren Anruf nicht annehmen. Auf Wiederhören.',
  messageSaved:
    'Danke, ich habe Ihre Nachricht weitergegeben, und das Team meldet sich bei Ihnen. Kann ich sonst noch etwas für Sie tun?',
  urgentFlagged:
    'Ich habe das für das Team als dringend markiert. Sind Sie unter der Nummer, von der Sie anrufen, am besten erreichbar?',
  recordingNotice: 'Dieser Anruf wird möglicherweise aufgezeichnet.',
  keypadOption: (label, key) => `Für ${label} drücken Sie die ${key}.`,
  keypadEnd: 'Oder sagen Sie mir einfach, wie ich helfen kann.',
  wrongKey: 'Diese Taste ist leider nicht im Menü.',
  justTellMe: 'Sagen Sie mir einfach, wie ich helfen kann.',
}

const it: SpokenLines = {
  greeting: (b, n, ai) =>
    `Grazie per aver chiamato ${b}. Sono ${n}${ai ? ", l'assistente IA" : ''}. Come posso aiutarla?`,
  fallbackGreeting: 'Grazie per aver chiamato. Come posso aiutarla?',
  aiSentence: n => `Sono ${n}, l'assistente IA.`,
  aiNote: /\bIA\b/,
  consentQuestion: 'Le va bene?',
  knownCaller: 'Salve {first_name}, che piacere risentirla.',
  goodbye: 'Grazie per aver chiamato. Arrivederci!',
  stillThere: 'È ancora in linea?',
  callLimit:
    'Mi dispiace, abbiamo raggiunto la durata massima di questa chiamata. Ho annotato tutto per il team e qualcuno la ricontatterà. Arrivederci!',
  testCallLimit: 'Questa chiamata di prova ha raggiunto la durata massima, quindi la chiudo ora. Arrivederci!',
  silenceClosing: 'Non sento nessuno in linea, quindi riattacco. Ci richiami quando vuole.',
  busy: 'Mi dispiace, al momento tutte le nostre linee sono occupate. La preghiamo di richiamare tra qualche minuto.',
  overCap: 'Mi dispiace, al momento non possiamo rispondere alla sua chiamata. La richiameremo il prima possibile.',
  blocked: 'Mi dispiace, non possiamo rispondere alla sua chiamata. Arrivederci.',
  messageSaved: "Grazie, ho inoltrato il suo messaggio e il team la ricontatterà. Posso aiutarla in qualcos'altro?",
  urgentFlagged:
    'Ho segnalato la cosa come urgente al team. Il numero da cui sta chiamando è il migliore per raggiungerla?',
  recordingNotice: 'Questa chiamata potrebbe essere registrata.',
  keypadOption: (label, key) => `Per ${label}, prema ${key}.`,
  keypadEnd: 'Oppure mi dica semplicemente come posso aiutarla.',
  wrongKey: 'Mi dispiace, quel tasto non è nel menu.',
  justTellMe: 'Mi dica semplicemente come posso aiutarla.',
}

const pt: SpokenLines = {
  greeting: (b, n, ai) =>
    `Obrigado por ligar para ${b}. Aqui é ${n}${ai ? ', assistente de IA' : ''}. Como posso ajudar?`,
  fallbackGreeting: 'Obrigado por ligar. Como posso ajudar?',
  aiSentence: n => `Aqui é ${n}, assistente de IA.`,
  aiNote: /\bIA\b/,
  consentQuestion: 'Tudo bem para você?',
  knownCaller: 'Olá {first_name}, que bom falar com você de novo.',
  goodbye: 'Obrigado por ligar. Até logo!',
  stillThere: 'Você ainda está aí?',
  callLimit:
    'Desculpe, atingimos o tempo máximo desta ligação. Anotei tudo para a equipe, e alguém vai entrar em contato com você. Até logo!',
  testCallLimit: 'Esta ligação de teste atingiu o tempo máximo, então vou encerrá-la agora. Até logo!',
  silenceClosing: 'Não estou ouvindo ninguém na linha, então vou desligar. Ligue para nós quando quiser.',
  busy: 'Desculpe, todas as nossas linhas estão ocupadas no momento. Por favor, ligue novamente em alguns minutos.',
  overCap: 'Desculpe, não podemos atender sua ligação agora. Retornaremos a ligação assim que possível.',
  blocked: 'Desculpe, não podemos atender sua ligação. Até logo.',
  messageSaved:
    'Obrigado, passei sua mensagem adiante e a equipe vai entrar em contato com você. Posso ajudar em mais alguma coisa?',
  urgentFlagged:
    'Marquei isso como urgente para a equipe. O número de onde você está ligando é o melhor para falar com você?',
  recordingNotice: 'Esta ligação pode ser gravada.',
  keypadOption: (label, key) => `Para ${label}, pressione ${key}.`,
  keypadEnd: 'Ou simplesmente me diga como posso ajudar.',
  wrongKey: 'Desculpe, essa tecla não está no menu.',
  justTellMe: 'Simplesmente me diga como posso ajudar.',
}

const nl: SpokenLines = {
  greeting: (b, n, ai) =>
    `Bedankt voor het bellen naar ${b}. U spreekt met ${n}${ai ? ', de AI-assistent' : ''}. Waarmee kan ik u helpen?`,
  fallbackGreeting: 'Bedankt voor het bellen. Waarmee kan ik u helpen?',
  aiSentence: n => `U spreekt met ${n}, de AI-assistent.`,
  aiNote: /\bAI\b/,
  consentQuestion: 'Is dat goed voor u?',
  knownCaller: 'Hallo {first_name}, fijn om weer van u te horen.',
  goodbye: 'Bedankt voor het bellen. Tot ziens!',
  stillThere: 'Bent u er nog?',
  callLimit:
    'Het spijt me, we hebben de maximale duur van dit gesprek bereikt. Ik heb alles voor het team genoteerd en er neemt iemand contact met u op. Tot ziens!',
  testCallLimit: 'Deze testoproep heeft de maximale duur bereikt, dus ik beëindig hem nu. Tot ziens!',
  silenceClosing: 'Ik hoor niemand aan de lijn, dus ik hang nu op. Bel ons gerust terug.',
  busy: 'Sorry, al onze lijnen zijn op dit moment bezet. Bel over een paar minuten terug.',
  overCap: 'Sorry, we kunnen uw oproep nu niet aannemen. We bellen u zo snel mogelijk terug.',
  blocked: 'Sorry, we kunnen uw oproep niet aannemen. Tot ziens.',
  messageSaved:
    'Bedankt, ik heb uw bericht doorgegeven en het team neemt contact met u op. Kan ik u nog ergens anders mee helpen?',
  urgentFlagged:
    'Ik heb dit als dringend gemarkeerd voor het team. Bent u het best bereikbaar op het nummer waarmee u belt?',
  recordingNotice: 'Dit gesprek kan worden opgenomen.',
  keypadOption: (label, key) => `Voor ${label}, druk op ${key}.`,
  keypadEnd: 'Of vertel me gewoon waarmee ik u kan helpen.',
  wrongKey: 'Sorry, die toets staat niet in het menu.',
  justTellMe: 'Vertel me gewoon waarmee ik u kan helpen.',
}

const ru: SpokenLines = {
  greeting: (b, n, ai) => `Спасибо, что позвонили в ${b}. Это ${n}${ai ? ', ИИ-ассистент' : ''}. Чем могу помочь?`,
  fallbackGreeting: 'Спасибо за звонок. Чем могу помочь?',
  aiSentence: n => `Это ${n}, ИИ-ассистент.`,
  aiNote: /ИИ/,
  consentQuestion: 'Вас это устраивает?',
  knownCaller: 'Здравствуйте, {first_name}, рады снова вас слышать.',
  goodbye: 'Спасибо за звонок. До свидания!',
  stillThere: 'Вы ещё на линии?',
  callLimit: 'Извините, время этого звонка истекло. Всё записано для команды, и с вами свяжутся. До свидания!',
  testCallLimit: 'Время этого тестового звонка истекло, поэтому звонок завершается. До свидания!',
  silenceClosing: 'На линии никого не слышно, поэтому звонок завершается. Перезвоните нам в любое время.',
  busy: 'Извините, все линии сейчас заняты. Пожалуйста, перезвоните через несколько минут.',
  overCap: 'Извините, сейчас мы не можем принять ваш звонок. Мы перезвоним вам как можно скорее.',
  blocked: 'Извините, мы не можем принять ваш звонок. До свидания.',
  messageSaved: 'Спасибо, ваше сообщение передано, и команда с вами свяжется. Могу ли я ещё чем-нибудь помочь?',
  urgentFlagged:
    'Это отмечено для команды как срочное. По номеру, с которого вы звоните, с вами лучше всего связаться?',
  recordingNotice: 'Этот звонок может записываться.',
  keypadOption: (label, key) => `${label}: нажмите ${key}.`,
  keypadEnd: 'Или просто скажите, чем я могу помочь.',
  wrongKey: 'Извините, такой клавиши нет в меню.',
  justTellMe: 'Просто скажите, чем я могу помочь.',
}

const hi: SpokenLines = {
  greeting: (b, n, ai) => `${b} में कॉल करने के लिए धन्यवाद। मैं ${n} हूँ${ai ? ', AI असिस्टेंट' : ''}। मैं आपकी कैसे मदद करूँ?`,
  fallbackGreeting: 'कॉल करने के लिए धन्यवाद। मैं आपकी कैसे मदद करूँ?',
  aiSentence: n => `मैं ${n} हूँ, AI असिस्टेंट।`,
  aiNote: /AI|एआई/,
  consentQuestion: 'क्या यह आपके लिए ठीक है?',
  knownCaller: 'नमस्ते {first_name}, आपसे फिर से बात करके अच्छा लगा।',
  goodbye: 'कॉल करने के लिए धन्यवाद। नमस्ते!',
  stillThere: 'क्या आप अभी भी लाइन पर हैं?',
  callLimit:
    'माफ़ कीजिए, इस कॉल की समय सीमा पूरी हो गई है। टीम के लिए सब कुछ नोट कर लिया गया है, और कोई आपसे संपर्क करेगा। नमस्ते!',
  testCallLimit: 'यह टेस्ट कॉल अपनी समय सीमा तक पहुँच गई है, इसलिए इसे अभी समाप्त किया जा रहा है। नमस्ते!',
  silenceClosing: 'लाइन पर कोई सुनाई नहीं दे रहा, इसलिए कॉल समाप्त की जा रही है। कभी भी दोबारा कॉल करें।',
  busy: 'माफ़ कीजिए, अभी हमारी सभी लाइनें व्यस्त हैं। कृपया कुछ मिनट बाद फिर से कॉल करें।',
  overCap: 'माफ़ कीजिए, हम अभी आपकी कॉल नहीं ले सकते। हम जल्द से जल्द आपको वापस कॉल करेंगे।',
  blocked: 'माफ़ कीजिए, हम आपकी कॉल नहीं ले सकते। नमस्ते।',
  messageSaved: 'धन्यवाद, आपका संदेश टीम तक पहुँचा दिया गया है, और वे आपसे संपर्क करेंगे। क्या और किसी चीज़ में मदद चाहिए?',
  urgentFlagged:
    'इसे टीम के लिए ज़रूरी के रूप में चिह्नित कर दिया गया है। क्या जिस नंबर से आप कॉल कर रहे हैं, उसी पर आपसे संपर्क करना सबसे अच्छा रहेगा?',
  recordingNotice: 'यह कॉल रिकॉर्ड की जा सकती है।',
  keypadOption: (label, key) => `${label} के लिए ${key} दबाएँ।`,
  keypadEnd: 'या बस बताइए कि मैं आपकी कैसे मदद करूँ।',
  wrongKey: 'माफ़ कीजिए, यह बटन मेनू में नहीं है।',
  justTellMe: 'बस बताइए कि मैं आपकी कैसे मदद करूँ।',
}

const ja: SpokenLines = {
  greeting: (b, n, ai) =>
    `お電話ありがとうございます。${b}の${ai ? 'AIアシスタント、' : ''}${n}です。どのようなご用件でしょうか？`,
  fallbackGreeting: 'お電話ありがとうございます。どのようなご用件でしょうか？',
  aiSentence: n => `AIアシスタントの${n}です。`,
  aiNote: /AI/,
  consentQuestion: 'よろしいでしょうか？',
  knownCaller: '{first_name}様、またお電話いただきありがとうございます。',
  goodbye: 'お電話ありがとうございました。失礼いたします。',
  stillThere: 'もしもし、聞こえていますか？',
  callLimit:
    '申し訳ございません、通話時間の上限に達しました。内容はすべてチームに伝えましたので、担当者からご連絡いたします。失礼いたします。',
  testCallLimit: 'テスト通話の時間上限に達したため、終了いたします。失礼いたします。',
  silenceClosing: 'お声が聞こえませんので、お電話を切らせていただきます。またいつでもお電話ください。',
  busy: '申し訳ございません、ただいま回線が大変混み合っております。数分後におかけ直しください。',
  overCap: '申し訳ございません、ただいまお電話をお受けできません。できるだけ早く折り返しご連絡いたします。',
  blocked: '申し訳ございません、お電話をお受けできません。失礼いたします。',
  messageSaved:
    'ありがとうございます。メッセージをお伝えしましたので、担当者からご連絡いたします。ほかに何かございますか？',
  urgentFlagged: '緊急としてチームに伝えました。今おかけの番号にご連絡すればよろしいでしょうか？',
  recordingNotice: 'この通話は録音される場合があります。',
  keypadOption: (label, key) => `${label}は${key}を押してください。`,
  keypadEnd: 'または、ご用件をそのままお話しください。',
  wrongKey: '申し訳ございません、そのボタンはメニューにありません。',
  justTellMe: 'ご用件をそのままお話しください。',
}

const LINES: Record<Language, SpokenLines> = { en, es, fr, de, it, pt, nl, ru, hi, ja }

/** The fixed lines in a language; English for an unknown one. */
export const spokenLines = (language: string | null | undefined): SpokenLines => LINES[language as Language] ?? en

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Business and assistant name from a text that is `language`'s default greeting (with or without the AI note); null otherwise. */
function parseDefaultGreeting(
  text: string,
  language: Language,
): { business: string; name: string; ai: boolean } | null {
  for (const ai of [true, false]) {
    const template = escapeRegExp(spokenLines(language).greeting('\u0001', '\u0002', ai))
      .replace('\u0001', '(.+?)')
      .replace('\u0002', '(.+?)')
    const match = new RegExp(`^${template}$`).exec(text)
    if (match) return { business: match[1]!, name: match[2]!, ai }
  }
  return null
}

const DEFAULT_TEXTS = ['fallbackGreeting', 'silenceClosing', 'knownCaller', 'recordingNotice'] as const

/**
 * An owner-written text after the main language changed from `from` to `to`: `to`'s default when the text is still
 * `from`'s default (the greeting the app wrote, the closing line, the returning-caller line, the recording notice),
 * else the text as written.
 */
export function swapDefault(text: string, from: Language, to: Language): string {
  if (from === to) return text
  const trimmed = text.trim()
  const greeting = parseDefaultGreeting(trimmed, from)
  if (greeting) return spokenLines(to).greeting(greeting.business, greeting.name, greeting.ai)
  const key = DEFAULT_TEXTS.find(k => spokenLines(from)[k] === trimmed)
  return key ? spokenLines(to)[key] : text
}

/** An owner-written text as a call in `language` says it: the language's default when it is still the English default. */
export const localizedDefault = (text: string, language: Language): string => swapDefault(text, 'en', language)
