// The fixed lines an assistant says on a call, in each language it can speak (languages.ts; spoken-lines.test.ts
// checks every language has every line): the default
// greeting, the AI note, goodbye, silence and limit lines, busy lines, quick tool replies and the hand-over lines.
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
  goodbye: string
  stillThere: string
  /** Said once when a slow tool (a lookup, the calendar) still runs after seconds and the model wrote no line for it. */
  stillChecking: string
  /** Asked before the call ends (end_call's first call): the assistant hangs up only after the caller answered it. */
  anythingElse: string
  callLimit: string
  testCallLimit: string
  silenceClosing: string
  busy: string
  overCap: string
  blocked: string
  /** After flag_urgent on a call with caller ID: asks whether that number is the best one. */
  urgentFlagged: string
  /**
   * After flag_urgent on a call without caller ID (a withheld number, a test or demo call from the browser): asks for a
   * number to call back on. Added 2026-11-16; every language but English is an AI translation, not yet checked by a
   * native speaker.
   */
  urgentFlaggedNoCallerId: string
  recordingNotice: string
  /** Said right before the ringback of a transfer: whom the assistant is trying to reach. */
  transferConnecting: (name: string) => string
  /** Said before the next contact's ringback, when the one before did not take the call. */
  transferNext: (previous: string, next: string) => string
  /** Said when a team member takes the call over from the app, before they speak. */
  takeOver: (name: string) => string
}

const en: SpokenLines = {
  greeting: (b, n, ai) => `Thanks for calling ${b}. This is ${n}${ai ? ', the AI assistant' : ''}. How can I help?`,
  fallbackGreeting: 'Thanks for calling. How can I help?',
  aiSentence: n => `This is ${n}, the AI assistant.`,
  aiNote: /,?\s*(?:the|an|your|a)\s+(?:virtual|AI)\s+assistant\b/i,
  consentQuestion: 'Is that okay with you?',
  goodbye: 'Thanks for calling. Goodbye!',
  stillThere: 'Are you still there?',
  stillChecking: "This is taking a little longer, I'm still on it.",
  anythingElse: 'Is there anything else I can help you with?',
  callLimit:
    "I'm sorry, we've reached the time limit for this call. I've noted everything for the team, and someone will get back to you. Goodbye!",
  testCallLimit: "This test call has reached its time limit, so I'll end it now. Goodbye!",
  silenceClosing: "I can't hear anyone on the line, so I'll hang up now. Please call us back anytime.",
  busy: 'Sorry, all our lines are busy right now. Please call back in a few minutes.',
  overCap: "Sorry, we can't take your call right now. We'll call you back as soon as we can.",
  blocked: "Sorry, we can't take your call. Goodbye.",
  urgentFlagged:
    "I've marked this as urgent for the team. Is the number you're calling from the best way to reach you?",
  urgentFlaggedNoCallerId: "I've marked this as urgent for the team. What number can we call you back on?",
  recordingNotice: 'This call may be recorded.',
  transferConnecting: n => `I'm trying to reach ${n} now. Please stay on the line.`,
  transferNext: (p, n) => `${p} can't take the call right now. Let me try ${n}. Please stay on the line.`,
  takeOver: n => `I'm putting you through to ${n} now.`,
}

const es: SpokenLines = {
  greeting: (b, n, ai) =>
    `Gracias por llamar a ${b}. Soy ${n}${ai ? ', asistente de IA' : ''}. ¿En qué puedo ayudarle?`,
  fallbackGreeting: 'Gracias por llamar. ¿En qué puedo ayudarle?',
  aiSentence: n => `Soy ${n}, asistente de IA.`,
  aiNote: /\bIA\b/,
  consentQuestion: '¿Le parece bien?',
  goodbye: 'Gracias por llamar. ¡Adiós!',
  stillThere: '¿Sigue ahí?',
  stillChecking: 'Esto está tardando un poco más, sigo en ello.',
  anythingElse: '¿Hay algo más en lo que pueda ayudarle?',
  callLimit:
    'Lo siento, hemos llegado al tiempo máximo de esta llamada. He anotado todo para el equipo y alguien se pondrá en contacto con usted. ¡Adiós!',
  testCallLimit: 'Esta llamada de prueba ha llegado a su tiempo máximo, así que la termino ahora. ¡Adiós!',
  silenceClosing: 'No oigo a nadie en la línea, así que voy a colgar. Llámenos cuando quiera.',
  busy: 'Lo siento, todas nuestras líneas están ocupadas. Por favor, vuelva a llamar en unos minutos.',
  overCap: 'Lo siento, ahora no podemos atender su llamada. Le devolveremos la llamada lo antes posible.',
  blocked: 'Lo siento, no podemos atender su llamada. Adiós.',
  urgentFlagged:
    'He marcado esto como urgente para el equipo. ¿El número desde el que llama es el mejor para localizarle?',
  urgentFlaggedNoCallerId: 'He marcado esto como urgente para el equipo. ¿A qué número le podemos devolver la llamada?',
  recordingNotice: 'Esta llamada puede ser grabada.',
  transferConnecting: n => `Estoy intentando comunicarme con ${n}. Por favor, no cuelgue.`,
  transferNext: (p, n) => `${p} no puede atender la llamada en este momento. Voy a intentarlo con ${n}. Por favor, no cuelgue.`,
  takeOver: n => `Le paso con ${n} ahora.`,
}

const fr: SpokenLines = {
  greeting: (b, n, ai) =>
    `Merci d'avoir appelé ${b}. Je suis ${n}${ai ? ', assistant IA' : ''}. Comment puis-je vous aider ?`,
  fallbackGreeting: "Merci d'avoir appelé. Comment puis-je vous aider ?",
  aiSentence: n => `Je suis ${n}, assistant IA.`,
  aiNote: /\bIA\b/,
  consentQuestion: 'Cela vous convient-il ?',
  goodbye: "Merci d'avoir appelé. Au revoir !",
  stillThere: 'Vous êtes toujours là ?',
  stillChecking: 'Cela prend un peu plus de temps, je m’en occupe toujours.',
  anythingElse: 'Puis-je vous aider pour autre chose ?',
  callLimit:
    "Désolé, nous avons atteint la durée maximale de cet appel. J'ai tout noté pour l'équipe, et quelqu'un vous recontactera. Au revoir !",
  testCallLimit: 'Cet appel de test a atteint sa durée maximale, je vais donc y mettre fin. Au revoir !',
  silenceClosing: "Je n'entends personne sur la ligne, je vais donc raccrocher. N'hésitez pas à nous rappeler.",
  busy: 'Désolé, toutes nos lignes sont occupées pour le moment. Merci de rappeler dans quelques minutes.',
  overCap: 'Désolé, nous ne pouvons pas prendre votre appel pour le moment. Nous vous rappellerons dès que possible.',
  blocked: 'Désolé, nous ne pouvons pas prendre votre appel. Au revoir.',
  urgentFlagged:
    "J'ai signalé cet appel comme urgent à l'équipe. Le numéro depuis lequel vous appelez est-il le meilleur pour vous joindre ?",
  urgentFlaggedNoCallerId: "J'ai signalé cet appel comme urgent à l'équipe. À quel numéro pouvons-nous vous rappeler ?",
  recordingNotice: 'Cet appel peut être enregistré.',
  transferConnecting: n => `J'essaie de joindre ${n}. Merci de rester en ligne.`,
  transferNext: (p, n) => `${p} ne peut pas prendre l'appel pour le moment. Je vais essayer ${n}. Merci de rester en ligne.`,
  takeOver: n => `Je vous passe ${n}.`,
}

const de: SpokenLines = {
  greeting: (b, n, ai) =>
    `Danke für Ihren Anruf bei ${b}. Hier ist ${n}${ai ? ', die KI-Assistenz' : ''}. Wie kann ich helfen?`,
  fallbackGreeting: 'Danke für Ihren Anruf. Wie kann ich helfen?',
  aiSentence: n => `Hier ist ${n}, die KI-Assistenz.`,
  aiNote: /\bKI\b/,
  consentQuestion: 'Ist das für Sie in Ordnung?',
  goodbye: 'Danke für Ihren Anruf. Auf Wiederhören!',
  stillThere: 'Sind Sie noch da?',
  stillChecking: 'Das dauert etwas länger, ich bin noch dran.',
  anythingElse: 'Kann ich Ihnen sonst noch mit etwas helfen?',
  callLimit:
    'Es tut mir leid, die maximale Gesprächsdauer ist erreicht. Ich habe alles für das Team notiert, und jemand meldet sich bei Ihnen. Auf Wiederhören!',
  testCallLimit: 'Dieser Testanruf hat seine maximale Dauer erreicht, deshalb beende ich ihn jetzt. Auf Wiederhören!',
  silenceClosing:
    'Ich höre niemanden in der Leitung, deshalb lege ich jetzt auf. Rufen Sie uns gerne jederzeit wieder an.',
  busy: 'Leider sind gerade alle Leitungen belegt. Bitte rufen Sie in ein paar Minuten wieder an.',
  overCap: 'Leider können wir Ihren Anruf gerade nicht annehmen. Wir rufen Sie so bald wie möglich zurück.',
  blocked: 'Leider können wir Ihren Anruf nicht annehmen. Auf Wiederhören.',
  urgentFlagged:
    'Ich habe das für das Team als dringend markiert. Sind Sie unter der Nummer, von der Sie anrufen, am besten erreichbar?',
  urgentFlaggedNoCallerId:
    'Ich habe das für das Team als dringend markiert. Unter welcher Nummer können wir Sie zurückrufen?',
  recordingNotice: 'Dieser Anruf wird möglicherweise aufgezeichnet.',
  transferConnecting: n => `Ich versuche jetzt, ${n} zu erreichen. Bitte bleiben Sie dran.`,
  transferNext: (p, n) => `${p} kann den Anruf gerade nicht annehmen. Ich versuche es bei ${n}. Bitte bleiben Sie dran.`,
  takeOver: n => `Ich verbinde Sie jetzt mit ${n}.`,
}

const it: SpokenLines = {
  greeting: (b, n, ai) =>
    `Grazie per aver chiamato ${b}. Sono ${n}${ai ? ", l'assistente IA" : ''}. Come posso aiutarla?`,
  fallbackGreeting: 'Grazie per aver chiamato. Come posso aiutarla?',
  aiSentence: n => `Sono ${n}, l'assistente IA.`,
  aiNote: /\bIA\b/,
  consentQuestion: 'Le va bene?',
  goodbye: 'Grazie per aver chiamato. Arrivederci!',
  stillThere: 'È ancora in linea?',
  stillChecking: 'Ci vuole un po’ più del previsto, ci sto ancora lavorando.',
  anythingElse: "Posso aiutarla con qualcos'altro?",
  callLimit:
    'Mi dispiace, abbiamo raggiunto la durata massima di questa chiamata. Ho annotato tutto per il team e qualcuno la ricontatterà. Arrivederci!',
  testCallLimit: 'Questa chiamata di prova ha raggiunto la durata massima, quindi la chiudo ora. Arrivederci!',
  silenceClosing: 'Non sento nessuno in linea, quindi riattacco. Ci richiami quando vuole.',
  busy: 'Mi dispiace, al momento tutte le nostre linee sono occupate. La preghiamo di richiamare tra qualche minuto.',
  overCap: 'Mi dispiace, al momento non possiamo rispondere alla sua chiamata. La richiameremo il prima possibile.',
  blocked: 'Mi dispiace, non possiamo rispondere alla sua chiamata. Arrivederci.',
  urgentFlagged:
    'Ho segnalato la cosa come urgente al team. Il numero da cui sta chiamando è il migliore per raggiungerla?',
  urgentFlaggedNoCallerId: 'Ho segnalato la cosa come urgente al team. A quale numero possiamo richiamarla?',
  recordingNotice: 'Questa chiamata potrebbe essere registrata.',
  transferConnecting: n => `Sto cercando di contattare ${n}. Resti in linea, per favore.`,
  transferNext: (p, n) => `${p} non può rispondere in questo momento. Provo con ${n}. Resti in linea, per favore.`,
  takeOver: n => `Le passo ${n} ora.`,
}

const pt: SpokenLines = {
  greeting: (b, n, ai) =>
    `Obrigado por ligar para ${b}. Aqui é ${n}${ai ? ', assistente de IA' : ''}. Como posso ajudar?`,
  fallbackGreeting: 'Obrigado por ligar. Como posso ajudar?',
  aiSentence: n => `Aqui é ${n}, assistente de IA.`,
  aiNote: /\bIA\b/,
  consentQuestion: 'Tudo bem para você?',
  goodbye: 'Obrigado por ligar. Até logo!',
  stillThere: 'Você ainda está aí?',
  stillChecking: 'Está demorando um pouco mais, ainda estou verificando.',
  anythingElse: 'Posso ajudar com mais alguma coisa?',
  callLimit:
    'Desculpe, atingimos o tempo máximo desta ligação. Anotei tudo para a equipe, e alguém vai entrar em contato com você. Até logo!',
  testCallLimit: 'Esta ligação de teste atingiu o tempo máximo, então vou encerrá-la agora. Até logo!',
  silenceClosing: 'Não estou ouvindo ninguém na linha, então vou desligar. Ligue para nós quando quiser.',
  busy: 'Desculpe, todas as nossas linhas estão ocupadas no momento. Por favor, ligue novamente em alguns minutos.',
  overCap: 'Desculpe, não podemos atender sua ligação agora. Retornaremos a ligação assim que possível.',
  blocked: 'Desculpe, não podemos atender sua ligação. Até logo.',
  urgentFlagged:
    'Marquei isso como urgente para a equipe. O número de onde você está ligando é o melhor para falar com você?',
  urgentFlaggedNoCallerId: 'Marquei isso como urgente para a equipe. Em qual número podemos retornar a ligação?',
  recordingNotice: 'Esta ligação pode ser gravada.',
  transferConnecting: n => `Estou tentando falar com ${n} agora. Por favor, aguarde na linha.`,
  transferNext: (p, n) => `${p} não pode atender agora. Vou tentar ${n}. Por favor, aguarde na linha.`,
  takeOver: n => `Vou transferir você para ${n} agora.`,
}

const nl: SpokenLines = {
  greeting: (b, n, ai) =>
    `Bedankt voor het bellen naar ${b}. U spreekt met ${n}${ai ? ', de AI-assistent' : ''}. Waarmee kan ik u helpen?`,
  fallbackGreeting: 'Bedankt voor het bellen. Waarmee kan ik u helpen?',
  aiSentence: n => `U spreekt met ${n}, de AI-assistent.`,
  aiNote: /\bAI\b/,
  consentQuestion: 'Is dat goed voor u?',
  goodbye: 'Bedankt voor het bellen. Tot ziens!',
  stillThere: 'Bent u er nog?',
  stillChecking: 'Dit duurt iets langer, ik ben er nog mee bezig.',
  anythingElse: 'Kan ik u ergens anders nog mee helpen?',
  callLimit:
    'Het spijt me, we hebben de maximale duur van dit gesprek bereikt. Ik heb alles voor het team genoteerd en er neemt iemand contact met u op. Tot ziens!',
  testCallLimit: 'Deze testoproep heeft de maximale duur bereikt, dus ik beëindig hem nu. Tot ziens!',
  silenceClosing: 'Ik hoor niemand aan de lijn, dus ik hang nu op. Bel ons gerust terug.',
  busy: 'Sorry, al onze lijnen zijn op dit moment bezet. Bel over een paar minuten terug.',
  overCap: 'Sorry, we kunnen uw oproep nu niet aannemen. We bellen u zo snel mogelijk terug.',
  blocked: 'Sorry, we kunnen uw oproep niet aannemen. Tot ziens.',
  urgentFlagged:
    'Ik heb dit als dringend gemarkeerd voor het team. Bent u het best bereikbaar op het nummer waarmee u belt?',
  urgentFlaggedNoCallerId: 'Ik heb dit als dringend gemarkeerd voor het team. Op welk nummer kunnen we u terugbellen?',
  recordingNotice: 'Dit gesprek kan worden opgenomen.',
  transferConnecting: n => `Ik probeer ${n} nu te bereiken. Blijft u even aan de lijn.`,
  transferNext: (p, n) => `${p} kan het gesprek nu niet aannemen. Ik probeer ${n}. Blijft u even aan de lijn.`,
  takeOver: n => `Ik verbind u nu door met ${n}.`,
}

const ru: SpokenLines = {
  greeting: (b, n, ai) => `Спасибо, что позвонили в ${b}. Это ${n}${ai ? ', ИИ-ассистент' : ''}. Чем могу помочь?`,
  fallbackGreeting: 'Спасибо за звонок. Чем могу помочь?',
  aiSentence: n => `Это ${n}, ИИ-ассистент.`,
  aiNote: /ИИ/,
  consentQuestion: 'Вас это устраивает?',
  goodbye: 'Спасибо за звонок. До свидания!',
  stillThere: 'Вы ещё на линии?',
  stillChecking: 'Это занимает чуть больше времени, я ещё проверяю.',
  anythingElse: 'Могу ли я помочь вам чем-нибудь ещё?',
  callLimit: 'Извините, время этого звонка истекло. Всё записано для команды, и с вами свяжутся. До свидания!',
  testCallLimit: 'Время этого тестового звонка истекло, поэтому звонок завершается. До свидания!',
  silenceClosing: 'На линии никого не слышно, поэтому звонок завершается. Перезвоните нам в любое время.',
  busy: 'Извините, все линии сейчас заняты. Пожалуйста, перезвоните через несколько минут.',
  overCap: 'Извините, сейчас мы не можем принять ваш звонок. Мы перезвоним вам как можно скорее.',
  blocked: 'Извините, мы не можем принять ваш звонок. До свидания.',
  urgentFlagged:
    'Это отмечено для команды как срочное. По номеру, с которого вы звоните, с вами лучше всего связаться?',
  urgentFlaggedNoCallerId: 'Это отмечено для команды как срочное. По какому номеру вам можно перезвонить?',
  recordingNotice: 'Этот звонок может записываться.',
  transferConnecting: n => `Сейчас я попробую связаться с ${n}. Пожалуйста, оставайтесь на линии.`,
  transferNext: (p, n) => `${p} сейчас не может ответить. Попробую связаться с ${n}. Пожалуйста, оставайтесь на линии.`,
  takeOver: n => `Соединяю вас с ${n}.`,
}

const hi: SpokenLines = {
  greeting: (b, n, ai) => `${b} में कॉल करने के लिए धन्यवाद। मैं ${n} हूँ${ai ? ', AI असिस्टेंट' : ''}। मैं आपकी कैसे मदद करूँ?`,
  fallbackGreeting: 'कॉल करने के लिए धन्यवाद। मैं आपकी कैसे मदद करूँ?',
  aiSentence: n => `मैं ${n} हूँ, AI असिस्टेंट।`,
  aiNote: /AI|एआई/,
  consentQuestion: 'क्या यह आपके लिए ठीक है?',
  goodbye: 'कॉल करने के लिए धन्यवाद। नमस्ते!',
  stillThere: 'क्या आप अभी भी लाइन पर हैं?',
  stillChecking: 'इसमें थोड़ा ज़्यादा समय लग रहा है, मैं अभी देख रही हूँ।',
  anythingElse: 'क्या आपकी किसी और चीज़ में मदद की जा सकती है?',
  callLimit:
    'माफ़ कीजिए, इस कॉल की समय सीमा पूरी हो गई है। टीम के लिए सब कुछ नोट कर लिया गया है, और कोई आपसे संपर्क करेगा। नमस्ते!',
  testCallLimit: 'यह टेस्ट कॉल अपनी समय सीमा तक पहुँच गई है, इसलिए इसे अभी समाप्त किया जा रहा है। नमस्ते!',
  silenceClosing: 'लाइन पर कोई सुनाई नहीं दे रहा, इसलिए कॉल समाप्त की जा रही है। कभी भी दोबारा कॉल करें।',
  busy: 'माफ़ कीजिए, अभी हमारी सभी लाइनें व्यस्त हैं। कृपया कुछ मिनट बाद फिर से कॉल करें।',
  overCap: 'माफ़ कीजिए, हम अभी आपकी कॉल नहीं ले सकते। हम जल्द से जल्द आपको वापस कॉल करेंगे।',
  blocked: 'माफ़ कीजिए, हम आपकी कॉल नहीं ले सकते। नमस्ते।',
  urgentFlagged:
    'इसे टीम के लिए ज़रूरी के रूप में चिह्नित कर दिया गया है। क्या जिस नंबर से आप कॉल कर रहे हैं, उसी पर आपसे संपर्क करना सबसे अच्छा रहेगा?',
  urgentFlaggedNoCallerId: 'इसे टीम के लिए ज़रूरी के रूप में चिह्नित कर दिया गया है। हम आपको किस नंबर पर वापस कॉल करें?',
  recordingNotice: 'यह कॉल रिकॉर्ड की जा सकती है।',
  transferConnecting: n => `मैं अभी ${n} से संपर्क करने की कोशिश कर रही हूँ। कृपया लाइन पर बने रहें।`,
  transferNext: (p, n) => `${p} अभी कॉल नहीं ले सकते। मैं ${n} से संपर्क करने की कोशिश करती हूँ। कृपया लाइन पर बने रहें।`,
  takeOver: n => `मैं आपको अभी ${n} से जोड़ रही हूँ।`,
}

const ja: SpokenLines = {
  greeting: (b, n, ai) =>
    `お電話ありがとうございます。${b}の${ai ? 'AIアシスタント、' : ''}${n}です。どのようなご用件でしょうか？`,
  fallbackGreeting: 'お電話ありがとうございます。どのようなご用件でしょうか？',
  aiSentence: n => `AIアシスタントの${n}です。`,
  aiNote: /AI/,
  consentQuestion: 'よろしいでしょうか？',
  goodbye: 'お電話ありがとうございました。失礼いたします。',
  stillThere: 'もしもし、聞こえていますか？',
  stillChecking: '少しお時間がかかっております。引き続き確認しております。',
  anythingElse: '他に何かお手伝いできることはありますか？',
  callLimit:
    '申し訳ございません、通話時間の上限に達しました。内容はすべてチームに伝えましたので、担当者からご連絡いたします。失礼いたします。',
  testCallLimit: 'テスト通話の時間上限に達したため、終了いたします。失礼いたします。',
  silenceClosing: 'お声が聞こえませんので、お電話を切らせていただきます。またいつでもお電話ください。',
  busy: '申し訳ございません、ただいま回線が大変混み合っております。数分後におかけ直しください。',
  overCap: '申し訳ございません、ただいまお電話をお受けできません。できるだけ早く折り返しご連絡いたします。',
  blocked: '申し訳ございません、お電話をお受けできません。失礼いたします。',
  urgentFlagged: '緊急としてチームに伝えました。今おかけの番号にご連絡すればよろしいでしょうか？',
  urgentFlaggedNoCallerId: '緊急としてチームに伝えました。折り返しのお電話番号を教えていただけますか？',
  recordingNotice: 'この通話は録音される場合があります。',
  transferConnecting: n => `ただいま${n}におつなぎしています。このままお待ちください。`,
  transferNext: (p, n) => `${p}は現在電話に出られません。${n}におつなぎします。このままお待ちください。`,
  takeOver: n => `${n}におつなぎします。`,
}

const zh: SpokenLines = {
  greeting: (b, n, ai) => `感谢您致电${b}。我是${ai ? 'AI助理' : ''}${n}。请问有什么可以帮您？`,
  fallbackGreeting: '感谢您的来电。请问有什么可以帮您？',
  aiSentence: n => `我是AI助理${n}。`,
  aiNote: /AI|人工智能/,
  consentQuestion: '您看可以吗？',
  goodbye: '感谢您的来电，再见！',
  stillThere: '请问您还在线吗？',
  stillChecking: '这需要多一点时间，我还在查。',
  anythingElse: '还有什么我可以帮您的吗？',
  callLimit: '非常抱歉，本次通话已达到时长上限。我已为团队记录了所有内容，稍后会有人与您联系。再见！',
  testCallLimit: '本次测试通话已达到时长上限，现在结束通话。再见！',
  silenceClosing: '线路上听不到声音，我先挂断了。欢迎您随时再打来。',
  busy: '非常抱歉，我们的线路目前全部占线。请过几分钟再拨打。',
  overCap: '非常抱歉，我们现在无法接听您的电话。我们会尽快给您回电。',
  blocked: '非常抱歉，我们无法接听您的电话。再见。',
  urgentFlagged: '我已为团队将此事标记为紧急。请问用您现在拨打的这个号码联系您最方便吗？',
  urgentFlaggedNoCallerId: '我已为团队将此事标记为紧急。请问我们打哪个号码给您回电？',
  recordingNotice: '本次通话可能会被录音。',
  transferConnecting: n => `我正在为您联系${n}，请不要挂断。`,
  transferNext: (p, n) => `${p}现在无法接听。我来试试联系${n}，请不要挂断。`,
  takeOver: n => `我现在为您转接${n}。`,
}

const ko: SpokenLines = {
  greeting: (b, n, ai) =>
    `${b}에 전화해 주셔서 감사합니다. ${ai ? 'AI 어시스턴트 ' : ''}${n}입니다. 무엇을 도와드릴까요?`,
  fallbackGreeting: '전화해 주셔서 감사합니다. 무엇을 도와드릴까요?',
  aiSentence: n => `AI 어시스턴트 ${n}입니다.`,
  aiNote: /AI|인공지능/,
  consentQuestion: '괜찮으시겠어요?',
  goodbye: '전화해 주셔서 감사합니다. 좋은 하루 보내세요!',
  stillThere: '여보세요, 아직 통화 중이신가요?',
  stillChecking: '조금 더 걸리고 있어요. 계속 확인하고 있습니다.',
  anythingElse: '더 도와드릴 일이 있을까요?',
  callLimit:
    '죄송합니다, 이번 통화가 최대 통화 시간에 도달했습니다. 모든 내용을 팀에 전달해 두었으니 곧 연락드리겠습니다. 좋은 하루 보내세요!',
  testCallLimit: '테스트 통화가 최대 시간에 도달해서 지금 종료하겠습니다. 감사합니다!',
  silenceClosing: '아무 소리도 들리지 않아 지금 전화를 끊겠습니다. 언제든지 다시 전화해 주세요.',
  busy: '죄송합니다, 지금은 모든 회선이 통화 중입니다. 몇 분 후에 다시 전화해 주세요.',
  overCap: '죄송합니다, 지금은 전화를 받을 수 없습니다. 최대한 빨리 다시 연락드리겠습니다.',
  blocked: '죄송합니다, 전화를 받을 수 없습니다. 안녕히 계세요.',
  urgentFlagged: '팀에 긴급 건으로 표시해 두었습니다. 지금 거신 번호로 연락드리면 될까요?',
  urgentFlaggedNoCallerId: '팀에 긴급 건으로 표시해 두었습니다. 어느 번호로 다시 연락드리면 될까요?',
  recordingNotice: '이 통화는 녹음될 수 있습니다.',
  transferConnecting: n => `지금 ${n} 님께 연결하고 있습니다. 끊지 말고 잠시만 기다려 주세요.`,
  transferNext: (p, n) => `지금 ${p} 님은 전화를 받을 수 없습니다. ${n} 님께 연결해 보겠습니다. 끊지 말고 잠시만 기다려 주세요.`,
  takeOver: n => `지금 ${n} 님께 연결해 드리겠습니다.`,
}

const pl: SpokenLines = {
  greeting: (b, n, ai) =>
    `Dzień dobry, dziękujemy za telefon do firmy ${b}. Z tej strony ${n}${ai ? ', asystent AI' : ''}. W czym mogę pomóc?`,
  fallbackGreeting: 'Dzień dobry, dziękujemy za telefon. W czym mogę pomóc?',
  aiSentence: n => `Z tej strony ${n}, asystent AI.`,
  aiNote: /\bAI\b|sztuczn\w+ inteligencj\w+/i,
  consentQuestion: 'Czy to w porządku?',
  goodbye: 'Dziękujemy za telefon. Do widzenia!',
  stillThere: 'Halo, czy jest ktoś na linii?',
  stillChecking: 'To trwa trochę dłużej, nadal sprawdzam.',
  anythingElse: 'Czy mogę pomóc w czymś jeszcze?',
  callLimit:
    'Przepraszam, osiągnęliśmy maksymalny czas tej rozmowy. Wszystko zostało zanotowane dla zespołu i ktoś się odezwie. Do widzenia!',
  testCallLimit: 'Ta rozmowa testowa osiągnęła maksymalny czas, więc teraz ją kończę. Do widzenia!',
  silenceClosing:
    'Nikogo nie słychać na linii, więc się rozłączam. Zapraszamy do ponownego kontaktu w dowolnej chwili.',
  busy: 'Przepraszamy, wszystkie nasze linie są teraz zajęte. Prosimy zadzwonić ponownie za kilka minut.',
  overCap: 'Przepraszamy, nie możemy teraz odebrać połączenia. Oddzwonimy najszybciej, jak to możliwe.',
  blocked: 'Przepraszamy, nie możemy przyjąć tego połączenia. Do widzenia.',
  urgentFlagged:
    'Sprawa została oznaczona dla zespołu jako pilna. Czy najlepiej kontaktować się pod numerem, z którego przychodzi to połączenie?',
  urgentFlaggedNoCallerId: 'Sprawa została oznaczona dla zespołu jako pilna. Pod jaki numer możemy oddzwonić?',
  recordingNotice: 'Ta rozmowa może być nagrywana.',
  transferConnecting: n => `Próbuję teraz skontaktować się z ${n}. Proszę pozostać na linii.`,
  transferNext: (p, n) => `${p} nie może teraz odebrać. Spróbuję połączyć z ${n}. Proszę pozostać na linii.`,
  takeOver: n => `Teraz łączę z ${n}.`,
}

const tr: SpokenLines = {
  greeting: (b, n, ai) =>
    `Aradığınız için teşekkür ederiz, burası ${b}. Ben ${n}${ai ? ', yapay zekâ asistanıyım' : ''}. Size nasıl yardımcı olabilirim?`,
  fallbackGreeting: 'Aradığınız için teşekkür ederiz. Size nasıl yardımcı olabilirim?',
  aiSentence: n => `Ben ${n}, yapay zekâ asistanıyım.`,
  aiNote: /yapay zek[aâ]|\bAI\b/i,
  consentQuestion: 'Sizin için uygun mu?',
  goodbye: 'Aradığınız için teşekkür ederiz. İyi günler!',
  stillThere: 'Hâlâ hatta mısınız?',
  stillChecking: 'Bu biraz daha uzun sürüyor, hâlâ kontrol ediyorum.',
  anythingElse: 'Size yardımcı olabileceğim başka bir şey var mı?',
  callLimit:
    'Üzgünüm, bu görüşmenin süre sınırına ulaştık. Her şeyi ekip için not ettim, size en kısa sürede dönüş yapılacak. İyi günler!',
  testCallLimit: 'Bu test araması süre sınırına ulaştı, bu yüzden şimdi sonlandırıyorum. İyi günler!',
  silenceClosing:
    'Hatta kimseyi duyamıyorum, bu yüzden şimdi kapatıyorum. Bizi istediğiniz zaman tekrar arayabilirsiniz.',
  busy: 'Üzgünüz, şu anda tüm hatlarımız meşgul. Lütfen birkaç dakika sonra tekrar arayın.',
  overCap: 'Üzgünüz, şu anda aramanızı yanıtlayamıyoruz. Sizi en kısa sürede geri arayacağız.',
  blocked: 'Üzgünüz, aramanızı kabul edemiyoruz. İyi günler.',
  urgentFlagged: 'Bunu ekip için acil olarak işaretledim. Size en iyi şu an aradığınız numaradan mı ulaşabiliriz?',
  urgentFlaggedNoCallerId: 'Bunu ekip için acil olarak işaretledim. Sizi hangi numaradan geri arayabiliriz?',
  recordingNotice: 'Bu görüşme kaydedilebilir.',
  transferConnecting: n => `Şimdi ${n} ile bağlantı kurmaya çalışıyorum. Lütfen hatta kalın.`,
  transferNext: (p, n) => `${p} şu anda çağrıyı alamıyor. ${n} ile deneyeceğim. Lütfen hatta kalın.`,
  takeOver: n => `Sizi şimdi ${n} ile bağlıyorum.`,
}

const vi: SpokenLines = {
  greeting: (b, n, ai) =>
    `Cảm ơn quý khách đã gọi đến ${b}. Tôi là ${n}${ai ? ', trợ lý AI' : ''}. Tôi có thể giúp gì cho quý khách?`,
  fallbackGreeting: 'Cảm ơn quý khách đã gọi. Tôi có thể giúp gì cho quý khách?',
  aiSentence: n => `Tôi là ${n}, trợ lý AI.`,
  aiNote: /\bAI\b|trí tuệ nhân tạo/i,
  consentQuestion: 'Quý khách thấy như vậy có được không ạ?',
  goodbye: 'Cảm ơn quý khách đã gọi. Chào quý khách!',
  stillThere: 'Quý khách còn nghe máy không ạ?',
  stillChecking: 'Việc này mất thêm một chút thời gian, tôi vẫn đang kiểm tra ạ.',
  anythingElse: 'Tôi có thể giúp gì thêm cho quý khách không?',
  callLimit:
    'Xin lỗi quý khách, cuộc gọi đã đạt thời lượng tối đa. Tôi đã ghi lại mọi thông tin cho đội ngũ, và sẽ có người liên hệ lại với quý khách. Chào quý khách!',
  testCallLimit: 'Cuộc gọi thử nghiệm này đã đạt thời lượng tối đa, nên tôi sẽ kết thúc ngay bây giờ. Chào quý khách!',
  silenceClosing:
    'Tôi không nghe thấy ai trên đường dây, nên tôi xin phép gác máy. Quý khách có thể gọi lại cho chúng tôi bất cứ lúc nào.',
  busy: 'Xin lỗi, hiện tất cả các đường dây của chúng tôi đều bận. Quý khách vui lòng gọi lại sau vài phút.',
  overCap: 'Xin lỗi, hiện chúng tôi không thể nhận cuộc gọi của quý khách. Chúng tôi sẽ gọi lại sớm nhất có thể.',
  blocked: 'Xin lỗi, chúng tôi không thể nhận cuộc gọi của quý khách. Chào quý khách.',
  urgentFlagged:
    'Tôi đã đánh dấu việc này là khẩn cấp cho đội ngũ. Số điện thoại quý khách đang gọi có phải là số tốt nhất để liên lạc không ạ?',
  urgentFlaggedNoCallerId:
    'Tôi đã đánh dấu việc này là khẩn cấp cho đội ngũ. Chúng tôi có thể gọi lại cho quý khách theo số nào ạ?',
  recordingNotice: 'Cuộc gọi này có thể được ghi âm.',
  transferConnecting: n => `Tôi đang liên hệ với ${n}. Xin quý khách vui lòng giữ máy.`,
  transferNext: (p, n) => `${p} hiện không thể nghe máy. Tôi sẽ thử liên hệ với ${n}. Xin quý khách vui lòng giữ máy.`,
  takeOver: n => `Tôi đang nối máy cho quý khách với ${n}.`,
}

const id: SpokenLines = {
  greeting: (b, n, ai) =>
    `Terima kasih telah menghubungi ${b}. Saya ${n}${ai ? ', asisten AI' : ''}. Ada yang bisa saya bantu?`,
  fallbackGreeting: 'Terima kasih telah menghubungi kami. Ada yang bisa saya bantu?',
  aiSentence: n => `Saya ${n}, asisten AI.`,
  aiNote: /\bAI\b|kecerdasan buatan/i,
  consentQuestion: 'Apakah Anda tidak keberatan?',
  goodbye: 'Terima kasih telah menelepon. Sampai jumpa!',
  stillThere: 'Apakah Anda masih di sana?',
  stillChecking: 'Ini memakan waktu sedikit lebih lama, saya masih memeriksanya.',
  anythingElse: 'Ada lagi yang bisa saya bantu?',
  callLimit:
    'Mohon maaf, panggilan ini sudah mencapai batas waktu. Saya sudah mencatat semuanya untuk tim, dan seseorang akan menghubungi Anda kembali. Sampai jumpa!',
  testCallLimit: 'Panggilan uji coba ini sudah mencapai batas waktu, jadi saya akhiri sekarang. Sampai jumpa!',
  silenceClosing:
    'Saya tidak mendengar siapa pun di saluran, jadi saya akan menutup telepon. Silakan hubungi kami kembali kapan saja.',
  busy: 'Mohon maaf, semua saluran kami sedang sibuk. Silakan telepon kembali dalam beberapa menit.',
  overCap:
    'Mohon maaf, kami tidak dapat menerima panggilan Anda saat ini. Kami akan menelepon Anda kembali secepatnya.',
  blocked: 'Mohon maaf, kami tidak dapat menerima panggilan Anda. Sampai jumpa.',
  urgentFlagged:
    'Saya sudah menandai ini sebagai mendesak untuk tim. Apakah nomor yang Anda gunakan sekarang adalah nomor terbaik untuk menghubungi Anda?',
  urgentFlaggedNoCallerId:
    'Saya sudah menandai ini sebagai mendesak untuk tim. Ke nomor berapa kami bisa menelepon Anda kembali?',
  recordingNotice: 'Panggilan ini mungkin direkam.',
  transferConnecting: n => `Saya sedang mencoba menghubungi ${n}. Mohon tetap di saluran.`,
  transferNext: (p, n) => `${p} tidak dapat menerima panggilan saat ini. Saya akan mencoba ${n}. Mohon tetap di saluran.`,
  takeOver: n => `Saya sambungkan Anda ke ${n} sekarang.`,
}

const sv: SpokenLines = {
  greeting: (b, n, ai) =>
    `Tack för att du ringer ${b}. Du pratar med ${n}${ai ? ', AI-assistenten' : ''}. Vad kan jag hjälpa dig med?`,
  fallbackGreeting: 'Tack för att du ringer. Vad kan jag hjälpa dig med?',
  aiSentence: n => `Du pratar med ${n}, AI-assistenten.`,
  aiNote: /\bAI\b/,
  consentQuestion: 'Går det bra för dig?',
  goodbye: 'Tack för att du ringde. Hej då!',
  stillThere: 'Är du kvar?',
  stillChecking: 'Det här tar lite längre tid, jag håller fortfarande på.',
  anythingElse: 'Finns det något mer jag kan hjälpa till med?',
  callLimit:
    'Tyvärr har vi nått maxtiden för det här samtalet. Jag har antecknat allt åt teamet, och någon hör av sig till dig. Hej då!',
  testCallLimit: 'Det här testsamtalet har nått sin maxtid, så jag avslutar det nu. Hej då!',
  silenceClosing: 'Jag hör ingen på linjen, så jag lägger på nu. Ring oss gärna igen när du vill.',
  busy: 'Tyvärr är alla våra linjer upptagna just nu. Ring gärna igen om några minuter.',
  overCap: 'Tyvärr kan vi inte ta ditt samtal just nu. Vi ringer upp dig så snart vi kan.',
  blocked: 'Tyvärr kan vi inte ta ditt samtal. Hej då.',
  urgentFlagged:
    'Jag har markerat det här som brådskande för teamet. Är numret du ringer från det bästa att nå dig på?',
  urgentFlaggedNoCallerId:
    'Jag har markerat det här som brådskande för teamet. Vilket nummer kan vi ringa tillbaka till dig på?',
  recordingNotice: 'Samtalet kan komma att spelas in.',
  transferConnecting: n => `Jag försöker nå ${n} nu. Var vänlig och stanna kvar i luren.`,
  transferNext: (p, n) => `${p} kan inte ta samtalet just nu. Jag försöker med ${n}. Var vänlig och stanna kvar i luren.`,
  takeOver: n => `Jag kopplar dig till ${n} nu.`,
}

const ar: SpokenLines = {
  greeting: (b, n, ai) => `شكرًا لاتصالك بـ ${b}. معك ${n}${ai ? '، مساعد الذكاء الاصطناعي' : ''}. كيف يمكنني مساعدتك؟`,
  fallbackGreeting: 'شكرًا لاتصالك. كيف يمكنني مساعدتك؟',
  aiSentence: n => `معك ${n}، مساعد الذكاء الاصطناعي.`,
  aiNote: /الذكاء الاصطناعي|\bAI\b/,
  consentQuestion: 'هل هذا مناسب لك؟',
  goodbye: 'شكرًا لاتصالك. مع السلامة!',
  stillThere: 'هل ما زلت على الخط؟',
  stillChecking: 'هذا يستغرق وقتًا أطول قليلًا، ما زلت أتحقق من ذلك.',
  anythingElse: 'هل هناك أي شيء آخر يمكنني مساعدتك به؟',
  callLimit: 'عذرًا، لقد وصلنا إلى الحد الأقصى لمدة هذه المكالمة. سجّلت كل شيء للفريق، وسيتواصل معك أحدهم. مع السلامة!',
  testCallLimit: 'وصلت هذه المكالمة التجريبية إلى حدها الأقصى، لذا سأنهيها الآن. مع السلامة!',
  silenceClosing: 'لا أسمع أحدًا على الخط، لذا سأنهي المكالمة الآن. يسعدنا اتصالك بنا في أي وقت.',
  busy: 'عذرًا، جميع خطوطنا مشغولة حاليًا. يُرجى معاودة الاتصال بعد بضع دقائق.',
  overCap: 'عذرًا، لا يمكننا الرد على مكالمتك الآن. سنعاود الاتصال بك في أقرب وقت ممكن.',
  blocked: 'عذرًا، لا يمكننا استقبال مكالمتك. مع السلامة.',
  urgentFlagged: 'لقد حددت هذا الطلب كعاجل للفريق. هل الرقم الذي تتصل منه هو أفضل رقم للتواصل معك؟',
  urgentFlaggedNoCallerId: 'لقد حددت هذا الطلب كعاجل للفريق. على أي رقم يمكننا معاودة الاتصال بك؟',
  recordingNotice: 'قد يتم تسجيل هذه المكالمة.',
  transferConnecting: n => `أحاول الآن الوصول إلى ${n}. يرجى البقاء على الخط.`,
  transferNext: (p, n) => `لا يستطيع ${p} الرد على المكالمة الآن. سأحاول مع ${n}. يرجى البقاء على الخط.`,
  takeOver: n => `سأحولك الآن إلى ${n}.`,
}

const uk: SpokenLines = {
  greeting: (b, n, ai) =>
    `Дякуємо, що зателефонували до ${b}. Це ${n}${ai ? ', ШІ-асистент' : ''}. Чим можу допомогти?`,
  fallbackGreeting: 'Дякуємо за дзвінок. Чим можу допомогти?',
  aiSentence: n => `Це ${n}, ШІ-асистент.`,
  aiNote: /ШІ|штучн\S* інтелект|\bAI\b/,
  consentQuestion: 'Вас це влаштовує?',
  goodbye: 'Дякуємо за дзвінок. До побачення!',
  stillThere: 'Ви ще на лінії?',
  stillChecking: 'Це займає трохи більше часу, я ще перевіряю.',
  anythingElse: 'Чи можу я допомогти вам ще чимось?',
  callLimit: 'Перепрошуємо, час цього дзвінка вичерпано. Усе записано для команди, і з вами зв’яжуться. До побачення!',
  testCallLimit: 'Час цього тестового дзвінка вичерпано, тому дзвінок завершується. До побачення!',
  silenceClosing: 'На лінії нікого не чути, тому дзвінок завершується. Телефонуйте нам будь-коли.',
  busy: 'Перепрошуємо, усі лінії зараз зайняті. Будь ласка, зателефонуйте за кілька хвилин.',
  overCap: 'Перепрошуємо, зараз ми не можемо прийняти ваш дзвінок. Ми передзвонимо вам якнайшвидше.',
  blocked: 'Перепрошуємо, ми не можемо прийняти ваш дзвінок. До побачення.',
  urgentFlagged:
    'Це позначено для команди як термінове. Чи найкраще зв’язатися з вами за номером, з якого ви телефонуєте?',
  urgentFlaggedNoCallerId: 'Це позначено для команди як термінове. За яким номером вам можна передзвонити?',
  recordingNotice: 'Цей дзвінок може записуватися.',
  transferConnecting: n => `Зараз я спробую зв'язатися з ${n}. Будь ласка, залишайтеся на лінії.`,
  transferNext: (p, n) => `${p} зараз не може відповісти. Спробую зв'язатися з ${n}. Будь ласка, залишайтеся на лінії.`,
  takeOver: n => `З'єдную вас із ${n}.`,
}

const ro: SpokenLines = {
  greeting: (b, n, ai) =>
    `Vă mulțumim că ați sunat la ${b}. Sunt ${n}${ai ? ', asistentul AI' : ''}. Cu ce vă pot ajuta?`,
  fallbackGreeting: 'Vă mulțumim că ați sunat. Cu ce vă pot ajuta?',
  aiSentence: n => `Sunt ${n}, asistentul AI.`,
  aiNote: /\bAI\b|\bIA\b|inteligență artificială/i,
  consentQuestion: 'Este în regulă pentru dumneavoastră?',
  goodbye: 'Vă mulțumim că ați sunat. La revedere!',
  stillThere: 'Mai sunteți la telefon?',
  stillChecking: 'Durează puțin mai mult, încă verific.',
  anythingElse: 'Vă mai pot ajuta cu altceva?',
  callLimit:
    'Îmi pare rău, am ajuns la durata maximă a acestui apel. Am notat totul pentru echipă și cineva vă va contacta. La revedere!',
  testCallLimit: 'Acest apel de test a ajuns la durata maximă, așa că îl închei acum. La revedere!',
  silenceClosing: 'Nu aud pe nimeni la telefon, așa că închid acum. Ne puteți suna oricând.',
  busy: 'Ne pare rău, toate liniile noastre sunt ocupate în acest moment. Vă rugăm să sunați din nou în câteva minute.',
  overCap: 'Ne pare rău, nu vă putem prelua apelul acum. Vă vom suna înapoi cât mai curând posibil.',
  blocked: 'Ne pare rău, nu vă putem prelua apelul. La revedere.',
  urgentFlagged:
    'Am marcat acest lucru ca urgent pentru echipă. Numărul de pe care sunați este cel mai bun pentru a vă contacta?',
  urgentFlaggedNoCallerId: 'Am marcat acest lucru ca urgent pentru echipă. La ce număr vă putem suna înapoi?',
  recordingNotice: 'Acest apel poate fi înregistrat.',
  transferConnecting: n => `Încerc acum să iau legătura cu ${n}. Vă rog să rămâneți la telefon.`,
  transferNext: (p, n) => `${p} nu poate prelua apelul acum. Încerc la ${n}. Vă rog să rămâneți la telefon.`,
  takeOver: n => `Vă fac legătura acum cu ${n}.`,
}

const cs: SpokenLines = {
  greeting: (b, n, ai) =>
    `Dobrý den, děkujeme, že voláte do firmy ${b}. U telefonu je ${n}${ai ? ', asistent s umělou inteligencí' : ''}. Jak vám mohu pomoci?`,
  fallbackGreeting: 'Dobrý den, děkujeme za zavolání. Jak vám mohu pomoci?',
  aiSentence: n => `U telefonu je ${n}, asistent s umělou inteligencí.`,
  aiNote: /umělou inteligencí|\bAI\b/i,
  consentQuestion: 'Je to pro vás v pořádku?',
  goodbye: 'Děkujeme za zavolání. Na shledanou!',
  stillThere: 'Jste stále na lince?',
  stillChecking: 'Trvá to trochu déle, ještě to zjišťuji.',
  anythingElse: 'Mohu vám pomoci ještě s něčím?',
  callLimit:
    'Omlouvám se, dosáhli jsme maximální délky tohoto hovoru. Vše je zapsáno pro tým a někdo se vám ozve. Na shledanou!',
  testCallLimit: 'Tento testovací hovor dosáhl maximální délky, proto ho teď ukončím. Na shledanou!',
  silenceClosing: 'Na lince nikoho neslyším, proto teď zavěsím. Zavolejte nám kdykoli znovu.',
  busy: 'Omlouváme se, všechny naše linky jsou právě obsazené. Zavolejte prosím znovu za pár minut.',
  overCap: 'Omlouváme se, váš hovor teď nemůžeme přijmout. Zavoláme vám zpět, jakmile to bude možné.',
  blocked: 'Omlouváme se, váš hovor nemůžeme přijmout. Na shledanou.',
  urgentFlagged: 'Pro tým je to teď označeno jako naléhavé. Jste nejlépe k zastižení na čísle, ze kterého voláte?',
  urgentFlaggedNoCallerId: 'Pro tým je to teď označeno jako naléhavé. Na jaké číslo vám můžeme zavolat zpět?',
  recordingNotice: 'Tento hovor může být nahráván.',
  transferConnecting: n => `Zkouším se teď spojit s ${n}. Zůstaňte prosím na lince.`,
  transferNext: (p, n) => `${p} teď nemůže hovor přijmout. Zkusím ${n}. Zůstaňte prosím na lince.`,
  takeOver: n => `Přepojuji vás teď na ${n}.`,
}

const el: SpokenLines = {
  greeting: (b, n, ai) =>
    `Σας ευχαριστούμε που επικοινωνήσατε με ${b}. Είμαι ${n}${ai ? ', βοηθός τεχνητής νοημοσύνης' : ''}. Πώς μπορώ να σας βοηθήσω;`,
  fallbackGreeting: 'Σας ευχαριστούμε για την κλήση. Πώς μπορώ να σας βοηθήσω;',
  aiSentence: n => `Είμαι ${n}, βοηθός τεχνητής νοημοσύνης.`,
  aiNote: /τεχνητής νοημοσύνης|\bAI\b/,
  consentQuestion: 'Είναι εντάξει για εσάς;',
  goodbye: 'Σας ευχαριστούμε για την κλήση. Αντίο σας!',
  stillThere: 'Είστε ακόμα στη γραμμή;',
  stillChecking: 'Αυτό παίρνει λίγο περισσότερο χρόνο, το ελέγχω ακόμα.',
  anythingElse: 'Μπορώ να σας βοηθήσω με κάτι άλλο;',
  callLimit:
    'Λυπάμαι, φτάσαμε στη μέγιστη διάρκεια αυτής της κλήσης. Τα έχω σημειώσει όλα για την ομάδα και κάποιος θα επικοινωνήσει μαζί σας. Αντίο σας!',
  testCallLimit: 'Αυτή η δοκιμαστική κλήση έφτασε στη μέγιστη διάρκειά της, οπότε την τερματίζω τώρα. Αντίο σας!',
  silenceClosing: 'Δεν ακούω κανέναν στη γραμμή, οπότε θα κλείσω τώρα. Καλέστε μας ξανά όποτε θέλετε.',
  busy: 'Λυπούμαστε, όλες οι γραμμές μας είναι κατειλημμένες αυτή τη στιγμή. Παρακαλούμε καλέστε ξανά σε λίγα λεπτά.',
  overCap:
    'Λυπούμαστε, δεν μπορούμε να απαντήσουμε στην κλήση σας αυτή τη στιγμή. Θα σας καλέσουμε πίσω το συντομότερο δυνατό.',
  blocked: 'Λυπούμαστε, δεν μπορούμε να δεχτούμε την κλήση σας. Αντίο σας.',
  urgentFlagged:
    'Το σημείωσα ως επείγον για την ομάδα. Ο αριθμός από τον οποίο καλείτε είναι ο καλύτερος για να επικοινωνήσουμε μαζί σας;',
  urgentFlaggedNoCallerId: 'Το σημείωσα ως επείγον για την ομάδα. Σε ποιον αριθμό μπορούμε να σας καλέσουμε πίσω;',
  recordingNotice: 'Αυτή η κλήση ενδέχεται να καταγράφεται.',
  transferConnecting: n => `Προσπαθώ να επικοινωνήσω με ${n}. Παρακαλώ μείνετε στη γραμμή.`,
  transferNext: (p, n) => `${p} δεν μπορεί να απαντήσει αυτή τη στιγμή. Θα δοκιμάσω με ${n}. Παρακαλώ μείνετε στη γραμμή.`,
  takeOver: n => `Σας συνδέω τώρα με ${n}.`,
}

const da: SpokenLines = {
  greeting: (b, n, ai) =>
    `Tak fordi du ringer til ${b}. Du taler med ${n}${ai ? ', AI-assistenten' : ''}. Hvad kan jeg hjælpe med?`,
  fallbackGreeting: 'Tak fordi du ringer. Hvad kan jeg hjælpe med?',
  aiSentence: n => `Du taler med ${n}, AI-assistenten.`,
  aiNote: /\bAI\b/,
  consentQuestion: 'Er det i orden med dig?',
  goodbye: 'Tak fordi du ringede. Farvel!',
  stillThere: 'Er du der stadig?',
  stillChecking: 'Det tager lidt længere tid, jeg er stadig i gang.',
  anythingElse: 'Er der andet, jeg kan hjælpe med?',
  callLimit:
    'Beklager, vi har nået den maksimale længde for dette opkald. Jeg har noteret det hele til teamet, og nogen vender tilbage til dig. Farvel!',
  testCallLimit: 'Dette testopkald har nået sin maksimale længde, så jeg afslutter det nu. Farvel!',
  silenceClosing:
    'Jeg kan ikke høre nogen på linjen, så jeg lægger på nu. Du er velkommen til at ringe igen når som helst.',
  busy: 'Beklager, alle vores linjer er optaget lige nu. Ring venligst igen om et par minutter.',
  overCap: 'Beklager, vi kan ikke tage dit opkald lige nu. Vi ringer dig op igen så hurtigt som muligt.',
  blocked: 'Beklager, vi kan ikke tage dit opkald. Farvel.',
  urgentFlagged:
    'Jeg har markeret det som hastende for teamet. Er det nummer, du ringer fra, det bedste at fange dig på?',
  urgentFlaggedNoCallerId: 'Jeg har markeret det som hastende for teamet. Hvilket nummer kan vi ringe dig tilbage på?',
  recordingNotice: 'Opkaldet kan blive optaget.',
  transferConnecting: n => `Jeg prøver at få fat i ${n} nu. Bliv venligst på linjen.`,
  transferNext: (p, n) => `${p} kan ikke tage opkaldet lige nu. Jeg prøver ${n}. Bliv venligst på linjen.`,
  takeOver: n => `Jeg stiller dig om til ${n} nu.`,
}

const fi: SpokenLines = {
  greeting: (b, n, ai) => `Kiitos soitostasi. ${b}, täällä ${n}${ai ? ', tekoälyavustaja' : ''}. Miten voin auttaa?`,
  fallbackGreeting: 'Kiitos soitostasi. Miten voin auttaa?',
  aiSentence: n => `Täällä ${n}, tekoälyavustaja.`,
  aiNote: /tekoäly|\bAI\b/i,
  consentQuestion: 'Sopiiko se sinulle?',
  goodbye: 'Kiitos soitostasi. Näkemiin!',
  stillThere: 'Oletko vielä linjalla?',
  stillChecking: 'Tämä vie hieman kauemmin, tarkistan vielä.',
  anythingElse: 'Voinko auttaa vielä jossakin muussa?',
  callLimit:
    'Valitettavasti tämän puhelun enimmäiskesto on täynnä. Kirjasin kaiken tiimille, ja joku on sinuun yhteydessä. Näkemiin!',
  testCallLimit: 'Tämä testipuhelu on saavuttanut enimmäiskestonsa, joten lopetan sen nyt. Näkemiin!',
  silenceClosing: 'En kuule linjalla ketään, joten lopetan puhelun nyt. Soita meille uudelleen milloin tahansa.',
  busy: 'Valitettavasti kaikki linjamme ovat juuri nyt varattuja. Soita uudelleen muutaman minuutin kuluttua.',
  overCap: 'Valitettavasti emme voi vastata puheluusi juuri nyt. Soitamme sinulle takaisin mahdollisimman pian.',
  blocked: 'Valitettavasti emme voi vastaanottaa puheluasi. Näkemiin.',
  urgentFlagged: 'Merkitsin tämän tiimille kiireelliseksi. Tavoittaako sinut parhaiten numerosta, josta soitat?',
  urgentFlaggedNoCallerId: 'Merkitsin tämän tiimille kiireelliseksi. Mihin numeroon voimme soittaa sinulle takaisin?',
  recordingNotice: 'Tämä puhelu saatetaan tallentaa.',
  transferConnecting: n => `Yritän nyt tavoittaa henkilön ${n}. Pysy linjalla.`,
  transferNext: (p, n) => `${p} ei pysty vastaamaan juuri nyt. Yritän tavoittaa henkilön ${n}. Pysy linjalla.`,
  takeOver: n => `Yhdistän sinut nyt henkilölle ${n}.`,
}

const no: SpokenLines = {
  greeting: (b, n, ai) =>
    `Takk for at du ringer ${b}. Du snakker med ${n}${ai ? ', AI-assistenten' : ''}. Hva kan jeg hjelpe deg med?`,
  fallbackGreeting: 'Takk for at du ringer. Hva kan jeg hjelpe deg med?',
  aiSentence: n => `Du snakker med ${n}, AI-assistenten.`,
  aiNote: /\bAI\b|\bKI\b/,
  consentQuestion: 'Er det greit for deg?',
  goodbye: 'Takk for at du ringte. Ha det bra!',
  stillThere: 'Er du der fortsatt?',
  stillChecking: 'Dette tar litt lengre tid, jeg holder fortsatt på.',
  anythingElse: 'Er det noe mer jeg kan hjelpe med?',
  callLimit:
    'Beklager, vi har nådd maksimal lengde for denne samtalen. Jeg har notert alt for teamet, og noen tar kontakt med deg. Ha det bra!',
  testCallLimit: 'Denne testsamtalen har nådd maksimal lengde, så jeg avslutter den nå. Ha det bra!',
  silenceClosing: 'Jeg hører ingen på linjen, så jeg legger på nå. Ring oss gjerne igjen når som helst.',
  busy: 'Beklager, alle linjene våre er opptatt akkurat nå. Ring gjerne igjen om noen minutter.',
  overCap: 'Beklager, vi kan ikke ta samtalen din akkurat nå. Vi ringer deg tilbake så snart vi kan.',
  blocked: 'Beklager, vi kan ikke ta samtalen din. Ha det bra.',
  urgentFlagged: 'Jeg har markert dette som haster for teamet. Er nummeret du ringer fra, det beste å nå deg på?',
  urgentFlaggedNoCallerId: 'Jeg har markert dette som haster for teamet. Hvilket nummer kan vi ringe deg tilbake på?',
  recordingNotice: 'Denne samtalen kan bli tatt opp.',
  transferConnecting: n => `Jeg prøver å nå ${n} nå. Vennligst bli på linjen.`,
  transferNext: (p, n) => `${p} kan ikke ta samtalen akkurat nå. Jeg prøver ${n}. Vennligst bli på linjen.`,
  takeOver: n => `Jeg setter deg over til ${n} nå.`,
}

const hu: SpokenLines = {
  greeting: (b, n, ai) =>
    `${b}, köszönjük a hívását. ${n} vagyok${ai ? ', mesterségesintelligencia-asszisztens' : ''}. Miben segíthetek?`,
  fallbackGreeting: 'Köszönjük a hívását. Miben segíthetek?',
  aiSentence: n => `${n} vagyok, mesterségesintelligencia-asszisztens.`,
  aiNote: /mesterséges\s*intelligencia|\bAI\b|\bMI\b/i,
  consentQuestion: 'Ez így megfelel Önnek?',
  goodbye: 'Köszönjük a hívását. Viszonthallásra!',
  stillThere: 'Halló, ott van még?',
  stillChecking: 'Ez egy kicsit tovább tart, még dolgozom rajta.',
  anythingElse: 'Segíthetek még valamiben?',
  callLimit:
    'Elnézést, elértük a hívás maximális időtartamát. Mindent feljegyeztem a csapatnak, és hamarosan felveszik Önnel a kapcsolatot. Viszonthallásra!',
  testCallLimit: 'Ez a teszthívás elérte a maximális időtartamát, ezért most befejezem. Viszonthallásra!',
  silenceClosing: 'Nem hallok senkit a vonalban, ezért most leteszem. Hívjon minket bármikor újra.',
  busy: 'Elnézést, jelenleg minden vonalunk foglalt. Kérjük, hívjon újra néhány perc múlva.',
  overCap: 'Elnézést, most nem tudjuk fogadni a hívását. A lehető leghamarabb visszahívjuk.',
  blocked: 'Elnézést, nem tudjuk fogadni a hívását. Viszonthallásra.',
  urgentFlagged: 'Ezt sürgősként jelöltem meg a csapatnak. Azon a számon érhetjük el a legjobban, amelyről most hív?',
  urgentFlaggedNoCallerId: 'Ezt sürgősként jelöltem meg a csapatnak. Melyik számon hívhatjuk vissza?',
  recordingNotice: 'Ez a hívás rögzítésre kerülhet.',
  transferConnecting: n => `Most próbálom elérni ${n} kollégánkat. Kérem, maradjon a vonalban.`,
  transferNext: (p, n) => `${p} most nem tudja fogadni a hívást. Megpróbálom ${n} kollégánkat. Kérem, maradjon a vonalban.`,
  takeOver: n => `Most kapcsolom ${n} kollégánkat.`,
}

const LINES: Record<Language, SpokenLines> = {
  en,
  es,
  fr,
  de,
  it,
  pt,
  nl,
  ru,
  hi,
  ja,
  zh,
  ko,
  pl,
  tr,
  vi,
  id,
  sv,
  ar,
  uk,
  ro,
  cs,
  el,
  da,
  fi,
  no,
  hu,
}

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

const DEFAULT_TEXTS = ['fallbackGreeting', 'silenceClosing', 'stillThere', 'goodbye', 'recordingNotice'] as const

/**
 * An owner-written text after the main language changed from `from` to `to`: `to`'s default when the text is still
 * `from`'s default (the greeting the app wrote, the closing line, the silence reminder, the recording notice),
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

/**
 * `language`'s default greeting with the AI note, when `text` is that default greeting without it; null otherwise.
 * Putting the AI sentence into it instead would name the assistant twice ("Soy Maya, asistente de IA. Soy Maya.").
 */
export function defaultGreetingWithAi(text: string, language: Language): string | null {
  const greeting = parseDefaultGreeting(text.trim(), language)
  return greeting && !greeting.ai ? spokenLines(language).greeting(greeting.business, greeting.name, true) : null
}

/** An owner-written text as a call in `language` says it: the language's default when it is still the English default. */
export const localizedDefault = (text: string, language: Language): string => swapDefault(text, 'en', language)

/** The business named in a text that is the English default greeting ("Thanks for calling X. This is Maya…"); null otherwise. */
export const businessOfGreeting = (text: string): string | null =>
  parseDefaultGreeting(text.trim(), 'en')?.business ?? null

// --- Public demo calls ------------------------------------------------------------------------
// A public demo call (apps/api/src/demo-call.ts) is a visitor of the install's website talking to a demo assistant in
// the browser. The visitor picks one of DEMO_LANGUAGES on the website; English is the default and the demo assistants'
// own language. The agent says the opening right after the greeting and ends the call after DEMO_CALL_MAX_SECONDS
// with the limit line, both in the call's language (demoLines).
// DRAFT – needs Janik's and Tim's OK before prod.

/** The longest a public demo call runs, in seconds: the agent ends it then, and the API tells the website. */
export const DEMO_CALL_MAX_SECONDS = 120

/**
 * The languages the demo has its fixed lines in (demoLines): Deepgram Flux's 10. A demo call in one of them speaks only
 * that one (no switching): accented English on multilingual Flux was too often heard as another language.
 */
export const DEMO_LINE_LANGUAGES = [
  'en',
  'es',
  'fr',
  'de',
  'it',
  'pt',
  'nl',
  'ru',
  'hi',
  'ja',
] as const satisfies readonly Language[]
export type DemoLineLanguage = (typeof DEMO_LINE_LANGUAGES)[number]

/**
 * The languages a visitor may pick for a demo call: those of DEMO_LINE_LANGUAGES whose demo calls passed the demo
 * language retest (2026-11-16, LIN-372). The others stay off until a retest passes; turning one on is adding it here
 * (and to the website's list).
 */
export const DEMO_LANGUAGES = ['en'] as const satisfies readonly DemoLineLanguage[]
export type DemoLanguage = (typeof DEMO_LANGUAGES)[number]

/** `opening`: said right after the greeting, as part of the same opening. `limit`: said at DEMO_CALL_MAX_SECONDS, before the agent hangs up. */
export type DemoLines = { opening: string; limit: string }

const DEMO_LINES: Record<DemoLineLanguage, DemoLines> = {
  en: {
    opening: 'This is a two-minute demo.',
    limit: "That's the two minutes for this demo. Thanks for trying it out. Goodbye!",
  },
  es: {
    opening: 'Esta es una demo de dos minutos.',
    limit: 'Se han acabado los dos minutos de esta demo. Gracias por probarla. ¡Adiós!',
  },
  fr: {
    opening: 'Ceci est une démo de deux minutes.',
    limit: "Les deux minutes de cette démo sont écoulées. Merci de l'avoir essayée. Au revoir !",
  },
  de: {
    opening: 'Das ist eine Zwei-Minuten-Demo.',
    limit: 'Die zwei Minuten dieser Demo sind um. Danke fürs Ausprobieren. Auf Wiederhören!',
  },
  it: {
    opening: 'Questa è una demo di due minuti.',
    limit: 'I due minuti di questa demo sono finiti. Grazie per averla provata. Arrivederci!',
  },
  pt: {
    opening: 'Esta é uma demonstração de dois minutos.',
    limit: 'Os dois minutos desta demonstração terminaram. Obrigado por experimentar. Até logo!',
  },
  nl: {
    opening: 'Dit is een demo van twee minuten.',
    limit: 'De twee minuten van deze demo zijn voorbij. Bedankt voor het uitproberen. Tot ziens!',
  },
  ru: {
    opening: 'Это двухминутная демонстрация.',
    limit: 'Две минуты этой демонстрации истекли. Спасибо, что попробовали. До свидания!',
  },
  hi: {
    opening: 'यह दो मिनट का डेमो है।',
    limit: 'इस डेमो के दो मिनट पूरे हो गए। इसे आज़माने के लिए धन्यवाद। नमस्ते!',
  },
  ja: {
    opening: 'これは2分間のデモです。',
    limit: 'このデモの2分間が終了しました。お試しいただきありがとうございました。失礼いたします。',
  },
}

/** Whether a value is one of DEMO_LANGUAGES. */
export const isDemoLanguage = (value: unknown): value is DemoLanguage =>
  (DEMO_LANGUAGES as readonly unknown[]).includes(value)

const isDemoLineLanguage = (value: unknown): value is DemoLineLanguage =>
  (DEMO_LINE_LANGUAGES as readonly unknown[]).includes(value)

/** A demo call's fixed lines in its language (any of DEMO_LINE_LANGUAGES); English for any other. */
export const demoLines = (language: string | null | undefined): DemoLines =>
  isDemoLineLanguage(language) ? DEMO_LINES[language] : DEMO_LINES.en
