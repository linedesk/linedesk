// Forwarding guides for France, Spain, Italy, Portugal, Sweden, Norway, Denmark, Finland and Poland (researched 15.11.2026).
// Sourcing rule and fields: see ../forwarding-guides.ts and ./shared.ts.
import { type ForwardingGuide, GSM_CHECK, GSM_STANDARD, gsmModes } from './shared.ts'

const ORANGE_PRO_CALL_FORWARDING = {
  url: 'https://assistancepro.orange.fr/telephone_mobile/la_messagerie_vocale_visuelle/messagerie_vocale/comment_programmer_un_renvoi_dappel_depuis_mon_mobile_-395750',
  label: 'Orange Pro: call forwarding from a mobile',
}
const MOVISTAR_CALL_FORWARDING_ON = {
  url: 'https://comunidad.movistar.es/kb/Gestiones/%C2%BFc%C3%B3mo-puedo-activar-desv%C3%ADo-de-llamadas-de-mi-m%C3%B3vil-movistar/3864076',
  label: 'Movistar: call forwarding on a mobile',
}
const VODAFONE_CALL_FORWARDING_ON = {
  url: 'https://ayudacliente.vodafone.es/particulares/movil/opciones-de-llamada-y-voz/como-desviar-llamadas-en-tu-movil/',
  label: 'Vodafone: call forwarding on a mobile',
}
const ILIAD_CALL_FORWARDING_AND = {
  url: 'https://assistenza.iliad.it/business/mobile/supporto/avviso-di-chiamata-segreteria-telefonica',
  label: 'iliad: call forwarding and voicemail (mobile)',
}
const FASTWEB_CALL_FORWARDING_ON = {
  url: 'https://www.fastweb.it/adsl-fibra-ottica/configurazione-cellulari/deviazione-di-chiamata/',
  label: 'Fastweb: call forwarding on a mobile',
}
const VODAFONE_CHECK_WHETHER_FORWARDING = {
  url: 'https://ajuda.vodafone.pt/loja-online-e-cobertura/chamadas-e-mensagens/como-verifico-se-um-reencaminhamento-esta-ativo',
  label: 'Vodafone: check whether forwarding is on',
}
const NOS_SET_UP_YOUR = {
  url: 'https://www.nos.pt/ajuda/telemovel-e-internet-movel/gerir-o-meu-numero-tarifario/configurar-o-telemovel',
  label: 'NOS: set up your mobile (voicemail and forwarding)',
}
const TELIA_CALL_FORWARDING = {
  url: 'https://www.telia.se/support/mobiltelefoni/guider/vidarekoppling',
  label: 'Telia: call forwarding',
}
const TELE2_CALL_FORWARDING = {
  url: 'https://www.tele2.se/support/mobilt/vidarekoppling',
  label: 'Tele2: call forwarding',
}
const COMVIQ_CALL_FORWARDING = {
  url: 'https://www.comviq.se/hjalp/mobilabonnemang/vidarekoppling',
  label: 'Comviq: call forwarding',
}
const TELENOR_CALL_FORWARDING_ON = {
  url: 'https://www.telenor.no/kundeservice/mobil/din-mobil/viderekobling/',
  label: 'Telenor: call forwarding on a mobile',
}
const TELENOR_BEDRIFT_CALL_FORWARDING = {
  url: 'https://www.telenor.no/bedrift/kundeservice/viderekobling/',
  label: 'Telenor Bedrift: call forwarding',
}
const OISTER_CALL_FORWARDING = {
  url: 'https://www.oister.dk/hjalp/mobil-support/viderestilling/',
  label: 'OiSTER: call forwarding',
}
const ELISA_CALL_FORWARDING_ON = {
  url: 'https://yrityksille.elisa.fi/ohje/soitonsiirrot-matkapuhelimessa',
  label: 'Elisa: call forwarding on a mobile',
}
const ORANGE_CALL_FORWARDING = {
  url: 'https://www.orange.pl/omnibook/przekierowanie-polaczen',
  label: 'Orange: call forwarding',
}
const T_MOBILE_CALL_FORWARDING = {
  url: 'https://www.t-mobile.pl/informacje-i-pomoc/pomoc-techniczna/aktywne-przekierowania-polaczen',
  label: 'T-Mobile: call forwarding',
}

export const europeSouthNordicsGuides: readonly ForwardingGuide[] = [
  {
    id: 'fr-orange',
    name: 'Orange',
    kind: 'mobile',
    countries: ['FR'],
    aliases: ['orange france', 'orange pro', 'orange business', 'sosh', 'france telecom'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '**61*{number}*11#',
            when: 'Not answered',
          },
          {
            code: '**67*{number}*11#',
            when: 'Busy',
          },
          {
            code: '**62*{number}*11#',
            when: 'Phone off or no signal',
          },
        ],
        off: [
          {
            code: '##61#',
          },
          {
            code: '##67#',
          },
          {
            code: '##62#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '**21*{number}*11#',
          },
        ],
        off: [
          {
            code: '##21#',
          },
        ],
      },
    },
    check: GSM_CHECK,
    pitfalls: [
      'Dial the codes from the phone itself; forwarding can’t be set in the Orange app or customer area.',
      'Orange forwards a missed call after 20 seconds of ringing; the code doesn’t change that.',
      'Forwarding replaces forwarding to your voicemail (888). ##002# removes all forwarding and brings voicemail back.',
      'Busy forwarding turns off call waiting while it’s on.',
      'Not available on Mobicarte (prepaid) lines.',
    ],
    sources: [
      ORANGE_PRO_CALL_FORWARDING,
      {
        url: 'https://assistance.orange.fr/article/solutions-de-continuite-de-services-conserver-vos-services-en-cas-de-panne-sur-le-reseau-mobile_741387',
        label: 'Orange: forwarding during a mobile network outage',
      },
    ],
  },
  {
    id: 'fr-sfr',
    name: 'SFR',
    kind: 'mobile',
    countries: ['FR'],
    aliases: ['sfr', 'red by sfr', 'red', 'sfr business', 'altice'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
          {
            code: '*62*{number}#',
            when: 'Phone off or no signal',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
          {
            code: '#62#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    check: GSM_CHECK,
    note: 'SFR’s own help site lists no mobile forwarding codes; these are the codes RED by SFR (SFR’s brand on the same network) documents. The off codes are the standard GSM ones.',
    pitfalls: [
      'Dial the codes from the phone itself and press call after each one.',
      'Missed calls normally ring 15 to 20 seconds before they forward.',
      'Forwarded calls count as calls from your line to your assistant’s number.',
    ],
    sources: [
      {
        url: 'https://assistance.red-by-sfr.fr/parametrer-mobile/repondeur.html',
        label: 'RED by SFR: voicemail and call options (forwarding codes)',
      },
      GSM_STANDARD,
    ],
  },
  {
    id: 'fr-bouygues',
    name: 'Bouygues Telecom',
    kind: 'mobile',
    countries: ['FR'],
    aliases: ['bouygues', 'bouygues telecom', 'bytel', 'b&you', 'bouygues telecom entreprises'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
          {
            code: '*62*{number}#',
            when: 'Phone off or no signal',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
          {
            code: '#62#',
          },
        ],
      },
    },
    note: 'Bouygues sets up forwarding of every call through its 610 voice menu, not a code: call 610, choose “Renvoyez tous mes appels vers le numéro de mon choix”, then enter your assistant’s number and #. #21# turns it off.',
    pitfalls: [
      'After each code you should hear a message confirming the forwarding and the number.',
      '#002# turns off all forwarding at once.',
      'Forwarding doesn’t work while call barring is on.',
      'Forwarding to a number outside Bouygues Telecom can be billed outside your plan.',
      'If forwarding won’t turn off: call 610, press 0, then 1 and 2 to reset your voicemail’s standard behaviour.',
    ],
    sources: [
      {
        url: 'https://www.assistance.bouyguestelecom.fr/s/article/activation-desactivation-renvoi-appel',
        label: 'Bouygues Telecom: call forwarding on a mobile',
      },
    ],
  },
  {
    id: 'fr-free',
    name: 'Free Mobile',
    kind: 'mobile',
    countries: ['FR'],
    aliases: ['free', 'free mobile', 'free pro', 'iliad'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
          {
            code: '*62*{number}#',
            when: 'Phone off or no signal',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
          {
            code: '#62#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    check: GSM_CHECK,
    pitfalls: [
      'Free documents the every-call code (*21*); the missed-call codes are the standard GSM ones its network uses. The check shows whether they took.',
      'Only numbers in mainland France (01 to 05, 09, 06, 07) can be forwarded to.',
      'Forwarded calls can be billed depending on your plan; see Free’s price brochure.',
    ],
    sources: [
      {
        url: 'https://support-pro.free.fr/comment-parametrer-un-renvoi-dappel/',
        label: 'Free Pro: set up call forwarding (mobile)',
      },
      {
        url: 'https://assistance.free.fr/articles/1755',
        label: 'Free: what mobile call forwarding is',
      },
      GSM_STANDARD,
    ],
  },
  {
    id: 'fr-orange-landline',
    name: 'Orange Pro landline',
    kind: 'landline',
    countries: ['FR'],
    aliases: ['orange pro fixe', 'orange ligne fixe', 'livebox pro', 'orange business fixe'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    note: 'Orange documents only forwarding every call from the desk phone. For missed calls only, use the Orange Pro app or the 3000 voice service (2 › 1).',
    pitfalls: [
      'Forwarding must first be added to your line in the Espace client Pro.',
      'Forwarded calls count against your plan like calls you make.',
      'Lines on a Livebox Pro PBX or a cloud PBX are set up elsewhere.',
    ],
    sources: [
      {
        url: 'https://assistancepro.orange.fr/telephone_fixe/rester_joignable/renvoi_et_transfert_d_appels/transfert_dappel_client_pro__activer_ou_desactiver-395336',
        label: 'Orange Pro: call transfer on a landline',
      },
      {
        url: 'https://assistancepro.orange.fr/telephone_fixe/rester_joignable/renvoi_et_transfert_d_appels/telephone_par_internet_pro__gerer_le_renvoi_dappel-395339',
        label: 'Orange Pro: manage forwarding on an internet phone line',
      },
    ],
  },
  {
    id: 'fr-sfr-landline',
    name: 'SFR box landline',
    kind: 'landline',
    countries: ['FR'],
    aliases: ['sfr fixe', 'sfr box', 'sfr business fixe', 'red box'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered',
          },
          {
            code: '*69*{number}#',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#69#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    check: [
      {
        code: '*#61#',
        when: 'Not answered',
      },
      {
        code: '*#69#',
        when: 'Busy',
      },
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    pitfalls: [
      'Busy forwarding only works with call waiting off (#79#).',
      'Dial from a phone connected to the SFR box.',
    ],
    sources: [
      {
        url: 'https://assistance.sfr.fr/internet-tel-fixe/tel-fixe/activer-desactiver-options.html',
        label: 'SFR: call options on a landline',
      },
    ],
  },
  {
    id: 'fr-freebox',
    name: 'Freebox landline',
    kind: 'landline',
    countries: ['FR'],
    aliases: ['freebox', 'free fixe', 'freebox pro'],
    how: 'dial',
    numberFormat: 'national',
    ringSeconds: 20,
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}*20#',
            when: 'Not answered within 20 seconds',
          },
          {
            code: '*69*{number}#',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#69#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    check: [
      {
        code: '*#61#',
        when: 'Not answered',
      },
      {
        code: '*#69#',
        when: 'Busy',
      },
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    pitfalls: [
      'Dial from the Freebox handset. On some phones press call after the code.',
      'The ring time can be 5 to 20 seconds.',
      'Free charges €0.05 a minute for each forwarded call.',
      'Also in the Freebox subscriber area: Téléphonie › Gestion de mes services téléphoniques.',
    ],
    sources: [
      {
        url: 'https://assistance.free.fr/articles/552',
        label: 'Free: forward on no answer (landline)',
      },
      {
        url: 'https://assistance.free.fr/articles/551',
        label: 'Free: forward when busy (landline)',
      },
      {
        url: 'https://assistance.free.fr/articles/553',
        label: 'Free: forward every call (landline)',
      },
    ],
  },
  {
    id: 'fr-other-mobile',
    name: 'Other French mobile',
    kind: 'mobile',
    countries: ['FR'],
    aliases: [
      'la poste mobile',
      'nrj mobile',
      'prixtel',
      'coriolis',
      'syma',
      'lebara',
      'lycamobile',
      'youprice',
      'auchan telecom',
      'cic mobile',
      'credit mutuel mobile',
    ],
    how: 'dial',
    numberFormat: 'national',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'Standard GSM codes. They work on most French networks; if one is refused, use your phone’s call forwarding settings.',
    pitfalls: ['Dial the codes from the phone itself.', '##002# turns off all forwarding.'],
    sources: [GSM_STANDARD, ORANGE_PRO_CALL_FORWARDING],
  },
  {
    id: 'es-movistar',
    name: 'Movistar',
    kind: 'mobile',
    countries: ['ES'],
    aliases: ['movistar', 'telefonica', 'telefónica', 'movistar empresas', 'o2 españa', 'tuenti'],
    how: 'dial',
    numberFormat: 'national',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: [
      {
        code: '*#61#',
        when: 'Not answered',
      },
      {
        code: '*#67#',
        when: 'Busy',
      },
      {
        code: '*#62#',
        when: 'Phone off or no signal',
      },
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    pitfalls: [
      'Dial the codes from the phone itself and press call.',
      'MultiSim lines can only forward every call.',
      'Prepaid lines need credit for forwarded calls.',
      'It can also be set in Mi Movistar under your mobile line.',
    ],
    sources: [
      MOVISTAR_CALL_FORWARDING_ON,
      {
        url: 'https://comunidad.movistar.es/blog/Noticias/c%C3%B3mo-activar-y-desactivar-desv%C3%ADos-de-llamadas-en-l%C3%ADneas-m%C3%B3viles/4120538',
        label: 'Movistar: forwarding in Mi Movistar',
      },
    ],
  },
  {
    id: 'es-vodafone',
    name: 'Vodafone',
    kind: 'mobile',
    countries: ['ES'],
    aliases: ['vodafone españa', 'vodafone spain', 'vodafone es', 'lowi', 'zegona'],
    how: 'dial',
    numberFormat: 'national',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'Vodafone charges a call setup fee (about €0.18) plus per-minute rates for each forwarded call.',
      'Not possible with consumption control on the line.',
      '##002# turns off all forwarding. You can also manage it in Mi Vodafone › Ajustes de línea › Opciones de llamada.',
    ],
    sources: [VODAFONE_CALL_FORWARDING_ON],
  },
  {
    id: 'es-orange',
    name: 'Orange',
    kind: 'mobile',
    countries: ['ES'],
    aliases: ['orange españa', 'orange spain', 'masorange', 'jazztel', 'simyo', 'amena'],
    how: 'dial',
    numberFormat: 'national',
    ringSeconds: 20,
    modes: gsmModes(20, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: [
      {
        code: '*#61#',
        when: 'Not answered',
      },
      {
        code: '*#67#',
        when: 'Busy',
      },
      {
        code: '*#62#',
        when: 'Phone off or no signal',
      },
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    pitfalls: [
      'The ring time can be 5 to 20 seconds, in steps of 5.',
      'Activation is free; you pay the call from your mobile to your assistant’s number.',
      'Also in Mi Orange › Llamadas nacionales.',
    ],
    sources: [
      {
        url: 'https://ayuda.orange.es/particulares/mi-orange/activar-servicios/777-desvia-las-llamadas-que-recibes-en-tu-movil-a-otro-numero',
        label: 'Orange: forward calls from your mobile',
      },
    ],
  },
  {
    id: 'es-masmovil',
    name: 'MásMóvil / Yoigo',
    kind: 'mobile',
    countries: ['ES'],
    aliases: ['masmovil', 'másmóvil', 'yoigo', 'pepephone', 'llamaya', 'masmovil empresas', 'yoigo negocios'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
          {
            code: '*62*{number}#',
            when: 'Phone off or no signal',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
          {
            code: '#62#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    check: GSM_CHECK,
    pitfalls: [
      'MásMóvil and Yoigo document the every-call code (*21*); the missed-call codes are the standard GSM ones. The check shows whether they took.',
      'Forwarded calls cost what your plan charges for calling that number.',
    ],
    sources: [
      {
        url: 'https://www.yoigo.com/ayuda/desvio-de-llamadas-en-el-movil',
        label: 'Yoigo: call forwarding on a mobile',
      },
      {
        url: 'https://www.masmovil.es/ayuda-clientes/como-activo-el-desvio-de-llamadas',
        label: 'MásMóvil: call forwarding',
      },
      GSM_STANDARD,
    ],
  },
  {
    id: 'es-movistar-landline',
    name: 'Movistar landline',
    kind: 'landline',
    countries: ['ES'],
    aliases: ['movistar fijo', 'telefonica fijo', 'movistar empresas fijo'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    pitfalls: [
      'The forwarding service must be on your line first (Movistar sells it as an add-on).',
      'Wait for the steady confirmation tone, then hang up.',
      'Forwarding only works to numbers in Spain.',
    ],
    sources: [
      {
        url: 'https://comunidad.movistar.es/kb/Gestiones/c%C3%B3mo-desviar-llamadas-de-fijo-a-m%C3%B3vil/3932892',
        label: 'Movistar: forward a landline to a mobile',
      },
      {
        url: 'https://www.movistar.es/blog/mi-movistar/desviar-llamadas-movistar/',
        label: 'Movistar: forwarding between landlines and mobiles',
      },
    ],
  },
  {
    id: 'es-orange-landline',
    name: 'Orange landline',
    kind: 'landline',
    countries: ['ES'],
    aliases: ['orange fijo', 'jazztel fijo'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    note: 'These are Orange’s codes for “indirect coverage” lines. On “direct coverage” lines Orange uses *21 + number (off *211*), *22 + number for busy (off *221*) and *23 + number for no answer (off *231*).',
    pitfalls: [
      'Lift the handset before dialling.',
      'If the codes are refused, your line is on direct coverage: use the codes in the note.',
    ],
    sources: [
      {
        url: 'https://ayuda.orange.es/particulares/internet-y-wi-fi/servicios/2055-desvia-las-llamadas-de-tu-telefono-fijo-de-orange-a-otro-fijo-o-a-un-movil',
        label: 'Orange: forward a landline',
      },
    ],
  },
  {
    id: 'es-other-mobile',
    name: 'Other Spanish mobile',
    kind: 'mobile',
    countries: ['ES'],
    aliases: [
      'digi',
      'digi mobil',
      'o2',
      'finetwork',
      'lebara',
      'lycamobile',
      'euskaltel',
      'r',
      'telecable',
      'virgin telco',
      'avatel',
    ],
    how: 'dial',
    numberFormat: 'national',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'Standard GSM codes. They work on most Spanish networks; if one is refused, use your phone’s call forwarding settings.',
    pitfalls: ['Dial the codes from the phone itself.', '##002# turns off all forwarding.'],
    sources: [GSM_STANDARD, MOVISTAR_CALL_FORWARDING_ON, VODAFONE_CALL_FORWARDING_ON],
  },
  {
    id: 'it-tim',
    name: 'TIM',
    kind: 'mobile',
    countries: ['IT'],
    aliases: ['tim', 'telecom italia', 'tim business', 'kena', 'kena mobile'],
    how: 'dial',
    numberFormat: 'national',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: [
      {
        code: '*#61#',
        when: 'Not answered',
      },
      {
        code: '*#67#',
        when: 'Busy',
      },
      {
        code: '*#62#',
        when: 'Phone off or no signal',
      },
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    pitfalls: [
      'TIM documents these codes for forwarding to its voicemail; the same codes forward to any number. The check shows whether they took.',
      'Turning forwarding on, off and checking it is free; you pay the leg from your line to your assistant.',
    ],
    sources: [
      {
        url: 'https://www.tim.it/assistenza/per-la-tua-linea/segreteria-telefonica-per-linea-mobile',
        label: 'TIM: voicemail and forwarding codes on a mobile',
      },
      GSM_STANDARD,
    ],
  },
  {
    id: 'it-vodafone',
    name: 'Vodafone',
    kind: 'mobile',
    countries: ['IT'],
    aliases: ['vodafone italia', 'vodafone it', 'vodafone business', 'ho mobile', 'ho.'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
          {
            code: '*62*{number}#',
            when: 'Phone off or no signal',
          },
        ],
        off: [
          {
            code: '##61#',
          },
          {
            code: '##67#',
          },
          {
            code: '##62#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '##21#',
          },
        ],
      },
    },
    check: [
      {
        code: '*#61#',
        when: 'Not answered',
      },
      {
        code: '*#67#',
        when: 'Busy',
      },
      {
        code: '*#62#',
        when: 'Phone off or no signal',
      },
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    pitfalls: [
      'Busy forwarding only works with call waiting off.',
      'Forwarded calls are billed at your pay-per-use national call rate; bundles and promotions don’t apply.',
      '##002# turns off all forwarding.',
    ],
    sources: [
      {
        url: 'https://www.vodafone.it/privati/area-supporto/servizi-aggiuntivi/servizi-voce-chiamate/come-funziona-trasferimento-chiamata.html',
        label: 'Vodafone: how call forwarding works',
      },
    ],
  },
  {
    id: 'it-windtre',
    name: 'WINDTRE',
    kind: 'mobile',
    countries: ['IT'],
    aliases: ['windtre', 'wind tre', 'wind', 'tre', '3 italia', 'very mobile', 'windtre business'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: [
      {
        code: '*#61#',
        when: 'Not answered',
      },
      {
        code: '*#62#',
        when: 'Phone off or no signal',
      },
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    pitfalls: [
      'WINDTRE documents these codes for forwarding to its voicemail; the same codes forward to any number. The check shows whether they took.',
      'Write the number with +39 in front, as WINDTRE does.',
      '##004# turns off all missed-call forwarding at once.',
    ],
    sources: [
      {
        url: 'https://www.windtre.it/servizi-utili/come-funziona-la-segreteria-telefonica-di-windtre',
        label: 'WINDTRE: voicemail and forwarding codes',
      },
      GSM_STANDARD,
    ],
  },
  {
    id: 'it-iliad',
    name: 'iliad',
    kind: 'mobile',
    countries: ['IT'],
    aliases: ['iliad', 'iliad italia', 'iliadbusiness'],
    how: 'dial',
    numberFormat: 'international',
    ringSeconds: 20,
    modes: {
      forward_conditional: {
        on: [
          {
            code: '**61*{number}*11*20#',
            when: 'Not answered within 20 seconds',
          },
          {
            code: '**67*{number}#',
            when: 'Busy',
          },
          {
            code: '**62*{number}#',
            when: 'Phone off or no signal',
          },
        ],
        off: [
          {
            code: '##61#',
          },
          {
            code: '##67#',
          },
          {
            code: '##62#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '**21*{number}#',
          },
        ],
        off: [
          {
            code: '##21#',
          },
        ],
      },
    },
    check: [
      {
        code: '*#61**11#',
        when: 'Not answered',
      },
      {
        code: '*#21**11#',
        when: 'Every call',
      },
    ],
    pitfalls: [
      'Write the number with +39 in front, as iliad does.',
      'Busy forwarding only works with call waiting (“Avviso di chiamata”) off.',
      'The ring time can be 5 to 30 seconds in steps of 5; 20 is iliad’s default.',
      'Forwarding isn’t included in the plan: forwarded calls are billed per use (see your price brochure).',
      '##002# turns off all forwarding, voicemail included.',
    ],
    sources: [ILIAD_CALL_FORWARDING_AND],
  },
  {
    id: 'it-fastweb',
    name: 'Fastweb Mobile',
    kind: 'mobile',
    countries: ['IT'],
    aliases: ['fastweb', 'fastweb mobile', 'fastweb business'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
          {
            code: '*62*{number}#',
            when: 'Phone off or no signal',
          },
        ],
        off: [
          {
            code: '##61#',
          },
          {
            code: '##67#',
          },
          {
            code: '##62#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '##21#',
          },
        ],
      },
    },
    check: [
      {
        code: '*#61#',
        when: 'Not answered',
      },
      {
        code: '*#67#',
        when: 'Busy',
      },
      {
        code: '*#62#',
        when: 'Phone off or no signal',
      },
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    pitfalls: ['Dial the codes from the phone itself and press call.'],
    sources: [FASTWEB_CALL_FORWARDING_ON],
  },
  {
    id: 'it-tim-landline',
    name: 'TIM landline (fibre)',
    kind: 'landline',
    countries: ['IT'],
    aliases: ['tim fisso', 'telecom italia fisso', 'tim fibra', 'tim business fisso'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*23*{number}#',
            when: 'Not answered',
          },
          {
            code: '*22*{number}#',
            when: 'Busy',
          },
          {
            code: '*24*{number}#',
            when: 'Line unreachable (modem off)',
          },
        ],
        off: [
          {
            code: '#23#',
          },
          {
            code: '#22#',
          },
          {
            code: '#24#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    check: [
      {
        code: '*#23#',
        when: 'Not answered',
      },
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    note: 'These are the codes for fibre lines (FTTC, FTTE, FTTH). Old copper (RTG) and ISDN lines only forward every call (*21*), and on RTG the service must be added by calling 187.',
    pitfalls: [
      'Don’t put a carrier-selection prefix in front of the number.',
      'While every call forwards, the phone has no normal dial tone; it returns after #21#.',
      'Forwarded calls are billed to your line under its plan.',
    ],
    sources: [
      {
        url: 'https://www.tim.it/assistenza/per-la-tua-linea/trasferimento-di-chiamata',
        label: 'TIM: call forwarding on your line',
      },
    ],
  },
  {
    id: 'it-fastweb-landline',
    name: 'Fastweb landline',
    kind: 'landline',
    countries: ['IT'],
    aliases: ['fastweb fisso', 'fastweb casa'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*23*{number}#',
            when: 'Not answered or unreachable',
          },
          {
            code: '*22*{number}#',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '#23#',
          },
          {
            code: '#22#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    check: [
      {
        code: '*#23#',
        when: 'Not answered',
      },
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    pitfalls: ['Forwarded calls cost 5 cents, even on plans with included calls.', 'Can also be set in MyFastweb.'],
    sources: [
      {
        url: 'https://www.fastweb.it/myfastweb/assistenza/guide/trasferimento-di-chiamata/',
        label: 'Fastweb: call forwarding on the landline',
      },
    ],
  },
  {
    id: 'it-windtre-landline',
    name: 'WINDTRE landline (In Trasferta)',
    kind: 'landline',
    countries: ['IT'],
    aliases: ['windtre fisso', 'wind fisso', 'in trasferta'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    check: [
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    note: 'WINDTRE documents only forwarding every call from the landline.',
    pitfalls: [
      'A steady tone means it’s on.',
      'Depending on your line, WINDTRE customer service may have to switch the service on first.',
    ],
    sources: [
      {
        url: 'https://www.windtre.it/servizi-utili/come-funziona-il-servizio-di-trasferimento-di-chiamata-windtre-in-trasferta',
        label: 'WINDTRE: In Trasferta call forwarding',
      },
    ],
  },
  {
    id: 'it-other-mobile',
    name: 'Other Italian mobile',
    kind: 'mobile',
    countries: ['IT'],
    aliases: ['postemobile', 'poste mobile', 'coopvoce', 'spusu', 'lycamobile', 'lebara', 'optima'],
    how: 'dial',
    numberFormat: 'national',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'Standard GSM codes. They work on most Italian networks; if one is refused, use your phone’s call forwarding settings.',
    pitfalls: ['Dial the codes from the phone itself.', '##002# turns off all forwarding.'],
    sources: [GSM_STANDARD, FASTWEB_CALL_FORWARDING_ON, ILIAD_CALL_FORWARDING_AND],
  },
  {
    id: 'pt-meo',
    name: 'MEO',
    kind: 'mobile',
    countries: ['PT'],
    aliases: ['meo', 'altice portugal', 'pt empresas', 'meo empresas', 'uzo', 'moche', 'tmn'],
    how: 'dial',
    numberFormat: 'national',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'MEO doesn’t publish its own codes. These are the standard GSM codes that Portuguese networks use; the check shows whether they took.',
      'If a code is refused, use your phone’s call forwarding settings.',
      '##002# turns off all forwarding.',
    ],
    sources: [GSM_STANDARD, VODAFONE_CHECK_WHETHER_FORWARDING, NOS_SET_UP_YOUR],
  },
  {
    id: 'pt-vodafone',
    name: 'Vodafone',
    kind: 'mobile',
    countries: ['PT'],
    aliases: ['vodafone portugal', 'vodafone pt', 'vodafone business pt'],
    how: 'dial',
    numberFormat: 'national',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: [
      {
        code: '*#61#',
        when: 'Not answered',
      },
      {
        code: '*#67#',
        when: 'Busy',
      },
      {
        code: '*#62#',
        when: 'Phone off or no signal',
      },
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    pitfalls: [
      'Vodafone documents the check codes (21, 61, 62, 67); the codes to turn forwarding on and off are the standard GSM ones. The check shows whether they took.',
      '##002# turns off all forwarding.',
    ],
    sources: [VODAFONE_CHECK_WHETHER_FORWARDING, GSM_STANDARD],
  },
  {
    id: 'pt-nos',
    name: 'NOS',
    kind: 'mobile',
    countries: ['PT'],
    aliases: ['nos', 'nos empresas', 'zon', 'optimus', 'woo'],
    how: 'dial',
    numberFormat: 'national',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'NOS’s own page writes the code with 66 in front of the number (**21*66 then the number #), and 66 also leads to NOS voicemail. These codes leave it out: if a code is refused or calls land in voicemail, ask NOS which form to use.',
      'The easiest way is the my NOS app or customer area.',
      '##002# turns off all forwarding; turn it off when you travel abroad, as forwarded calls cost roaming rates.',
    ],
    sources: [NOS_SET_UP_YOUR, GSM_STANDARD],
  },
  {
    id: 'pt-nos-landline',
    name: 'NOS landline',
    kind: 'landline',
    countries: ['PT'],
    aliases: ['nos fixo', 'nos telefone fixo'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    note: 'NOS documents only forwarding every call from the landline.',
    pitfalls: [
      'Press the green key first, then the code. Some phones need # instead of the green key at the end.',
      'Only for fibre or cable lines.',
      'Billed as a call from your landline to your assistant’s number.',
    ],
    sources: [
      {
        url: 'https://www.nos.pt/ajuda/outros/voz-fixa/configurar-o-telefone',
        label: 'NOS: set up your landline',
      },
    ],
  },
  {
    id: 'pt-other-mobile',
    name: 'Other Portuguese mobile',
    kind: 'mobile',
    countries: ['PT'],
    aliases: ['digi', 'digi portugal', 'nowo', 'lycamobile', 'amigo'],
    how: 'dial',
    numberFormat: 'national',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'Standard GSM codes. They work on most Portuguese networks; if one is refused, use your phone’s call forwarding settings.',
    pitfalls: ['Dial the codes from the phone itself.', '##002# turns off all forwarding.'],
    sources: [GSM_STANDARD, VODAFONE_CHECK_WHETHER_FORWARDING, NOS_SET_UP_YOUR],
  },
  {
    id: 'se-telia',
    name: 'Telia',
    kind: 'mobile',
    countries: ['SE'],
    aliases: ['telia', 'telia sverige', 'telia företag', 'halebop', 'fello'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
          {
            code: '*62*{number}#',
            when: 'Phone off or no signal',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
          {
            code: '#62#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    pitfalls: [
      'Telia’s examples write the number with 46 instead of the first 0; the number with its area code works too.',
      'The ring time before a missed call forwards is about 30 seconds and can’t be changed.',
      '#002# turns off all forwarding.',
      'The same codes work on a Telia landline, dialled from that phone.',
    ],
    sources: [
      TELIA_CALL_FORWARDING,
      {
        url: 'https://www.telia.se/foretag/support/info/vidarekoppling-mobiltelefoni',
        label: 'Telia Företag: call forwarding',
      },
    ],
  },
  {
    id: 'se-tele2',
    name: 'Tele2',
    kind: 'mobile',
    countries: ['SE'],
    aliases: ['tele2', 'tele2 företag', 'tele2 sverige'],
    how: 'dial',
    numberFormat: 'national',
    ringSeconds: 20,
    modes: gsmModes(20, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'Include the area code in the number.',
      'The ring time can be 5 to 30 seconds; 20 is about 4 rings.',
      '##002# resets all forwarding to your subscription’s defaults.',
      'Forwarding to a number outside Tele2 follows your price plan.',
    ],
    sources: [
      TELE2_CALL_FORWARDING,
      {
        url: 'https://www.tele2.se/foretag/support/telefoni/mobiltelefoni-vidarekoppling',
        label: 'Tele2 Företag: call forwarding',
      },
      COMVIQ_CALL_FORWARDING,
    ],
  },
  {
    id: 'se-comviq',
    name: 'Comviq',
    kind: 'mobile',
    countries: ['SE'],
    aliases: ['comviq'],
    network: 'Tele2',
    how: 'dial',
    numberFormat: 'national',
    ringSeconds: 20,
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}**20#',
            when: 'Not answered within 20 seconds',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
          {
            code: '*62*{number}#',
            when: 'Phone off or no signal',
          },
        ],
        off: [
          {
            code: '##61#',
          },
          {
            code: '##67#',
          },
          {
            code: '##62#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '##21#',
          },
        ],
      },
    },
    check: GSM_CHECK,
    note: 'Comviq runs on Tele2’s network; its page has no off codes, so these are Tele2’s.',
    pitfalls: [
      'Only on subscriptions, not prepaid (kontantkort).',
      'Include the area code in the number.',
      'It can also be set in Mitt konto.',
    ],
    sources: [COMVIQ_CALL_FORWARDING, TELE2_CALL_FORWARDING],
  },
  {
    id: 'se-telenor',
    name: 'Telenor',
    kind: 'mobile',
    countries: ['SE'],
    aliases: ['telenor', 'telenor sverige', 'telenor företag', 'vimla'],
    domesticOnly: true,
    how: 'dial',
    numberFormat: 'national',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'Telenor doesn’t publish its own codes. These are the standard GSM codes that Swedish networks use; the check shows whether they took.',
      'Telenor also lets you set forwarding in Mitt Telenor › Inställningar › Röstbrevlåda och vidarekoppling.',
      'Forwarding to numbers abroad doesn’t work.',
    ],
    sources: [GSM_STANDARD, TELIA_CALL_FORWARDING, TELE2_CALL_FORWARDING],
  },
  {
    id: 'se-tre',
    name: 'Tre (3)',
    kind: 'mobile',
    countries: ['SE'],
    aliases: ['tre', '3', 'hi3g', 'tre företag', 'hallon'],
    how: 'dial',
    numberFormat: 'national',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'Tre doesn’t publish its own codes. These are the standard GSM codes that Swedish networks use; the check shows whether they took.',
      'Include the area code in the number.',
    ],
    sources: [GSM_STANDARD, TELIA_CALL_FORWARDING, TELE2_CALL_FORWARDING],
  },
  {
    id: 'se-other-mobile',
    name: 'Other Swedish mobile',
    kind: 'mobile',
    countries: ['SE'],
    aliases: ['lycamobile', 'lebara', 'chilimobil', 'telness', 'mybeat'],
    how: 'dial',
    numberFormat: 'national',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'Standard GSM codes. They work on most Swedish networks; if one is refused, use your phone’s call forwarding settings.',
    pitfalls: ['Dial the codes from the phone itself.', '##002# turns off all forwarding.'],
    sources: [GSM_STANDARD, TELE2_CALL_FORWARDING],
  },
  {
    id: 'no-telenor',
    name: 'Telenor',
    kind: 'mobile',
    countries: ['NO'],
    aliases: ['telenor', 'telenor norge', 'telenor bedrift', 'djuice'],
    how: 'dial',
    numberFormat: 'national',
    ringSeconds: 20,
    modes: gsmModes(20, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'The ring time can be up to 30 seconds.',
      'Codes can’t be sent from 2G-only phones; use a phone with 4G calling.',
      'With Mobilt Bedriftsnett, set forwarding in Mitt MBN or the MBN app instead.',
      '##002# turns off all forwarding.',
    ],
    sources: [TELENOR_CALL_FORWARDING_ON, TELENOR_BEDRIFT_CALL_FORWARDING],
  },
  {
    id: 'no-talkmore',
    name: 'Talkmore',
    kind: 'mobile',
    countries: ['NO'],
    aliases: ['talkmore'],
    network: 'Telenor',
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '**61*{number}#',
            when: 'Not answered',
          },
          {
            code: '**67*{number}#',
            when: 'Busy',
          },
          {
            code: '**62*{number}#',
            when: 'Phone off or no signal',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
          {
            code: '#62#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '**21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    check: [
      {
        code: '*#61#',
        when: 'Not answered',
      },
      {
        code: '*#67#',
        when: 'Busy',
      },
      {
        code: '*#62#',
        when: 'Phone off or no signal',
      },
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    pitfalls: [
      'Press call after each code.',
      'With Talkmore Bedriftsnett, forward through the Bedriftsnett app.',
      '##002# turns off all forwarding.',
    ],
    sources: [
      {
        url: 'https://talkmore.no/privat/kundesenter/tjenester/viderekobling',
        label: 'Talkmore: call forwarding',
      },
    ],
  },
  {
    id: 'no-telia',
    name: 'Telia',
    kind: 'mobile',
    countries: ['NO'],
    aliases: ['telia', 'telia norge', 'netcom', 'onecall', 'chess', 'mycall'],
    how: 'dial',
    numberFormat: 'national',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'Telia doesn’t publish its own codes. These are the standard GSM codes that Norwegian networks use; the check shows whether they took.',
      'Telia also lets you change forwarding on Min Side.',
      'With Bedriftsnett or Smart Connect, set forwarding in that app instead.',
    ],
    sources: [
      GSM_STANDARD,
      {
        url: 'https://www.telia.no/personsvar/',
        label: 'Telia: Personsvar (forwarding on Min Side)',
      },
      TELENOR_CALL_FORWARDING_ON,
    ],
  },
  {
    id: 'no-ice',
    name: 'ice',
    kind: 'mobile',
    countries: ['NO'],
    aliases: ['ice', 'ice norge', 'ice bedrift'],
    how: 'dial',
    numberFormat: 'national',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'ice doesn’t publish its own codes. These are the standard GSM codes that Norwegian networks use; the check shows whether they took.',
      'ice also lets you change forwarding under call settings on Min Side or in the ice app.',
      'With ice Bedriftsnett, set forwarding in the switchboard (Profil › Innkommende samtaler › Viderekobling).',
    ],
    sources: [
      GSM_STANDARD,
      {
        url: 'https://www.ice.no/kundeservice/mitt-mobilabonnement/innstillinger-for-abonnement/viderekobling/',
        label: 'ice: call forwarding settings',
      },
      TELENOR_CALL_FORWARDING_ON,
    ],
  },
  {
    id: 'no-telenor-landline',
    name: 'Telenor landline (IP telephony)',
    kind: 'landline',
    countries: ['NO'],
    aliases: ['telenor fasttelefon', 'telenor ipt', 'ipt enbruker'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered after 20 seconds',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    pitfalls: [
      'Lift the handset and wait for the dial tone before the code.',
      'Missed calls forward after 20 seconds; it can’t be changed.',
    ],
    sources: [TELENOR_BEDRIFT_CALL_FORWARDING],
  },
  {
    id: 'no-other-mobile',
    name: 'Other Norwegian mobile',
    kind: 'mobile',
    countries: ['NO'],
    aliases: ['lyse', 'fjordkraft mobil', 'happybytes', 'saga mobil', 'nortel', 'lycamobile'],
    how: 'dial',
    numberFormat: 'national',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'Standard GSM codes. They work on most Norwegian networks; if one is refused, use your phone’s call forwarding settings.',
    pitfalls: ['Dial the codes from the phone itself.', '##002# turns off all forwarding.'],
    sources: [GSM_STANDARD, TELENOR_CALL_FORWARDING_ON],
  },
  {
    id: 'dk-tdc-erhverv',
    name: 'TDC Erhverv',
    kind: 'mobile',
    countries: ['DK'],
    aliases: ['tdc', 'tdc erhverv', 'tdc business', 'nuuday'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*92{number}',
            when: 'Not answered',
          },
          {
            code: '*90{number}',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '*93',
          },
          {
            code: '*91',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*72{number}',
          },
        ],
        off: [
          {
            code: '*73',
          },
        ],
      },
    },
    note: 'TDC Erhverv uses its own star codes, not the GSM ones. TDC lists no code for phone off or no signal; forwarding every call covers that.',
    pitfalls: [
      'No # at the end: dial the code and number straight after each other, then press call.',
      'Wait for the voice message that confirms the change.',
      'It can also be set in the TDC Assist app.',
      'Test it: call your number from another phone.',
    ],
    sources: [
      {
        url: 'https://tdc.dk/da/kundeservice/mobil/viderestilling-af-opkald-pa-mobil',
        label: 'TDC Erhverv: call forwarding on a mobile',
      },
    ],
  },
  {
    id: 'dk-yousee',
    name: 'YouSee',
    kind: 'mobile',
    countries: ['DK'],
    aliases: ['yousee', 'yousee mobil', 'tdc privat'],
    how: 'settings',
    where: 'Mit YouSee',
    modes: {
      forward_conditional: {
        on: [
          'Log in to Mit YouSee with MitID.',
          'Tap the arrow next to your mobile number › Indstillinger › turn viderestilling on.',
          'Choose when calls forward (not answered, busy, unreachable), choose “another number” and enter {number}.',
          'Tap Ok to save.',
        ],
        off: ['Turn viderestilling off in the same place.'],
      },
      forward_all: {
        on: [
          'Log in to Mit YouSee with MitID.',
          'Tap the arrow next to your mobile number › Indstillinger › turn viderestilling on.',
          'Choose that all calls forward, choose “another number” and enter {number}.',
          'Tap Ok to save.',
        ],
        off: ['Turn viderestilling off in the same place.'],
      },
    },
    check: 'Mit YouSee › your mobile number › Indstillinger',
    note: 'YouSee documents forwarding in Mit YouSee, not with codes.',
    pitfalls: ['The exact choices in Mit YouSee may be named a little differently; pick the ones for missed calls.'],
    sources: [
      {
        url: 'https://yousee.dk/hjaelp/artikler/hvordan-bruger-jeg-viderestilling-pa-mobilen',
        label: 'YouSee: call forwarding on a mobile',
      },
    ],
  },
  {
    id: 'dk-3',
    name: '3 (Tre) / OiSTER',
    kind: 'mobile',
    countries: ['DK'],
    aliases: ['3', 'tre', 'hi3g', '3business', 'oister'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: [
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    note: 'Codes from OiSTER, a brand of 3 (Hi3G Denmark) on the same network.',
    pitfalls: [
      'Write the number with +45 in front.',
      'Turn Mobilsvar (voicemail) off first, or forwarding to a number won’t work.',
      '##002# turns off all missed-call forwarding at once.',
    ],
    sources: [OISTER_CALL_FORWARDING],
  },
  {
    id: 'dk-norlys',
    name: 'Norlys (Telia, Telenor)',
    kind: 'mobile',
    countries: ['DK'],
    aliases: ['norlys', 'telia', 'telia danmark', 'telenor', 'telenor danmark', 'cbb', 'call me', 'norlys erhverv'],
    how: 'settings',
    where: 'Mit Norlys (business: Mit Norlys Erhverv)',
    modes: {
      forward_conditional: {
        on: [
          'Log in to Mit Norlys Erhverv.',
          'Abonnement › your number › Opkaldsindstillinger.',
          'Set forwarding when not answered, busy and unreachable to {number}, and save.',
        ],
        off: ['Set those forwardings back to voicemail or off in the same place.'],
      },
      forward_all: {
        on: [
          'Log in to Mit Norlys Erhverv.',
          'Abonnement › your number › Opkaldsindstillinger.',
          'Set forwarding of all calls to {number}, and save.',
        ],
        off: ['Turn it off in the same place.'],
      },
    },
    check: 'Mit Norlys Erhverv › Abonnement › Opkaldsindstillinger',
    note: 'Norlys says GSM codes for voicemail settings no longer work on its network, so use Mit Norlys. Telenor’s older page also lists *21*number# (off #21#) for every call, at a monthly fee.',
    pitfalls: ['Voicemail picks up after 15 seconds of ringing unless forwarding is set.'],
    sources: [
      {
        url: 'https://shop.norlys.dk/erhverv/hjaelp/faq/?categoryId=4312',
        label: 'Norlys Erhverv FAQ: voicemail and forwarding',
      },
      {
        url: 'https://www.telenor.dk/kundeservice/abonnementer-og-services/mobil/andre-services/viderestilling/',
        label: 'Telenor: call forwarding (older page)',
      },
    ],
  },
  {
    id: 'dk-tdc-landline',
    name: 'TDC Erhverv landline',
    kind: 'landline',
    countries: ['DK'],
    aliases: ['tdc fastnet', 'tdc erhverv fastnet', 'pstn professionel'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    check: [
      {
        code: '*#61#',
        when: 'Not answered',
      },
      {
        code: '*#67#',
        when: 'Busy',
      },
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    pitfalls: ['Your subscription must allow forwarding (PSTN Professionel Plus includes it).'],
    sources: [
      {
        url: 'https://tdc.dk/da/kundeservice/fastnettelefoni/viderestilling-fastnettelefoni',
        label: 'TDC: call forwarding on a landline',
      },
    ],
  },
  {
    id: 'dk-yousee-landline',
    name: 'YouSee landline',
    kind: 'landline',
    countries: ['DK'],
    aliases: ['yousee fastnet', 'yousee telefoni'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered',
          },
          {
            code: '*67*{number}#',
            when: 'Busy (phone on the router)',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    check: GSM_CHECK,
    pitfalls: ['YouSee lists busy forwarding only for phones connected to the router.'],
    sources: [
      {
        url: 'https://yousee.dk/hjaelp/artikler/viderestilling-pa-fastnettelefon',
        label: 'YouSee: call forwarding on a landline',
      },
    ],
  },
  {
    id: 'dk-other-mobile',
    name: 'Other Danish mobile',
    kind: 'mobile',
    countries: ['DK'],
    aliases: ['lebara', 'lycamobile', 'greentel', 'flexii', 'duka'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'Standard GSM codes. They work on most Danish networks; if one is refused, use your phone’s call forwarding settings.',
    pitfalls: ['Write the number with +45 in front.', '##002# turns off all forwarding.'],
    sources: [GSM_STANDARD, OISTER_CALL_FORWARDING],
  },
  {
    id: 'fi-elisa',
    name: 'Elisa',
    kind: 'mobile',
    countries: ['FI'],
    aliases: ['elisa', 'saunalahti', 'elisa yrityksille'],
    how: 'dial',
    numberFormat: 'international',
    ringSeconds: 20,
    modes: gsmModes(20, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: [
      {
        code: '*#61#',
        when: 'Not answered',
      },
      {
        code: '*#67#',
        when: 'Busy',
      },
      {
        code: '*#62#',
        when: 'Phone off or no signal',
      },
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    pitfalls: [
      'Write the number with +358 in front so forwarding also works abroad.',
      'The ring time can be 5 to 30 seconds in steps of 5.',
      'Forwarding every call can’t run at the same time as the missed-call forwardings.',
      '##002# turns off all forwarding.',
    ],
    sources: [ELISA_CALL_FORWARDING_ON],
  },
  {
    id: 'fi-telia',
    name: 'Telia',
    kind: 'mobile',
    countries: ['FI'],
    aliases: ['telia', 'telia finland', 'sonera'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: [
      {
        code: '*#61#',
        when: 'Not answered',
      },
      {
        code: '*#67#',
        when: 'Busy',
      },
      {
        code: '*#62#',
        when: 'Phone off or no signal',
      },
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    pitfalls: [
      'Telia documents the check codes (21, 61, 62, 67) and ##002#; the codes to turn forwarding on are the standard GSM ones. The check shows whether they took.',
      'Lines with VIP or Touchpoint can’t be managed with codes; use that service instead.',
    ],
    sources: [
      {
        url: 'https://www.telia.fi/yrityksille/asiakastuki/puhelinliittymat/soitonsiirtojen-tarkistaminen-ja-poistaminen',
        label: 'Telia: check and remove call forwarding',
      },
      GSM_STANDARD,
    ],
  },
  {
    id: 'fi-dna',
    name: 'DNA',
    kind: 'mobile',
    countries: ['FI'],
    aliases: ['dna', 'moi', 'dna yrityksille'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'DNA doesn’t publish its own codes. These are the standard GSM codes that Finnish networks use; the check shows whether they took.',
      'Write the number with +358 in front.',
    ],
    sources: [GSM_STANDARD, ELISA_CALL_FORWARDING_ON],
  },
  {
    id: 'fi-other-mobile',
    name: 'Other Finnish mobile',
    kind: 'mobile',
    countries: ['FI'],
    aliases: ['moi mobiili', 'globetel', 'lycamobile'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'Standard GSM codes. They work on most Finnish networks; if one is refused, use your phone’s call forwarding settings.',
    pitfalls: ['Write the number with +358 in front.', '##002# turns off all forwarding.'],
    sources: [GSM_STANDARD, ELISA_CALL_FORWARDING_ON],
  },
  {
    id: 'pl-orange',
    name: 'Orange',
    kind: 'mobile',
    countries: ['PL'],
    aliases: ['orange polska', 'orange pl', 'orange biznes', 'nju', 'nju mobile', 'ptk centertel'],
    domesticOnly: true,
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: [
      {
        code: '*#61#',
        when: 'Not answered',
      },
      {
        code: '*#67#',
        when: 'Busy',
      },
      {
        code: '*#62#',
        when: 'Phone off or no signal',
      },
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    pitfalls: [
      'Only on contract (abonament) lines.',
      'Only to Polish numbers; write it with +48 in front.',
      'You pay for the whole forwarded call.',
      '##002# turns off all forwarding.',
    ],
    sources: [ORANGE_CALL_FORWARDING],
  },
  {
    id: 'pl-tmobile',
    name: 'T-Mobile',
    kind: 'mobile',
    countries: ['PL'],
    aliases: ['t-mobile polska', 't-mobile pl', 'tmobile', 'heyah', 'era'],
    domesticOnly: true,
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: [
      {
        code: '*#61#',
        when: 'Not answered',
      },
      {
        code: '*#67#',
        when: 'Busy',
      },
      {
        code: '*#62#',
        when: 'Phone off or no signal',
      },
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    pitfalls: [
      'Only to Polish numbers; write it with +48 in front.',
      'Confirm each code with the green call button.',
      '##002# turns off all forwarding.',
    ],
    sources: [T_MOBILE_CALL_FORWARDING],
  },
  {
    id: 'pl-play',
    name: 'Play',
    kind: 'mobile',
    countries: ['PL'],
    aliases: ['play', 'p4', 'virgin mobile polska', 'play biznes', 'upc'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'Play doesn’t publish its own codes. These are the standard GSM codes that Polish networks use; the check shows whether they took.',
      'Write the number with +48 in front.',
    ],
    sources: [GSM_STANDARD, ORANGE_CALL_FORWARDING, T_MOBILE_CALL_FORWARDING],
  },
  {
    id: 'pl-plus',
    name: 'Plus',
    kind: 'mobile',
    countries: ['PL'],
    aliases: ['plus', 'polkomtel', 'plus biznes', 'plush', 'cyfrowy polsat'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'Plus doesn’t publish its own codes. These are the standard GSM codes that Polish networks use; the check shows whether they took.',
      'Write the number with +48 in front.',
    ],
    sources: [GSM_STANDARD, ORANGE_CALL_FORWARDING, T_MOBILE_CALL_FORWARDING],
  },
  {
    id: 'pl-orange-landline',
    name: 'Orange landline',
    kind: 'landline',
    countries: ['PL'],
    aliases: ['orange stacjonarny', 'tp', 'telekomunikacja polska', 'orange światłowód'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    note: 'For a landline number, include its area code. ISDN lines use different codes with your 7-digit number.',
    pitfalls: ['Confirm each code with the green handset key.'],
    sources: [ORANGE_CALL_FORWARDING],
  },
  {
    id: 'pl-play-landline',
    name: 'Play landline',
    kind: 'landline',
    countries: ['PL'],
    aliases: ['play stacjonarny', 'play telefon stacjonarny'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    pitfalls: ['Lift the handset, then dial the code.', 'You pay for the forwarded leg at your plan’s rate.'],
    sources: [
      {
        url: 'https://www.play.pl/pomoc/wsparcie-techniczne/telefon-stacjonarny/funkcje-dodatkowe-telefonu-stacjonarnego',
        label: 'Play: landline extra features',
      },
    ],
  },
  {
    id: 'pl-other-mobile',
    name: 'Other Polish mobile',
    kind: 'mobile',
    countries: ['PL'],
    aliases: ['lycamobile', 'premium mobile', 'mobile vikings', 'otvarta', 'a2mobile'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'Standard GSM codes. They work on most Polish networks; if one is refused, use your phone’s call forwarding settings.',
    pitfalls: ['Write the number with +48 in front.', '##002# turns off all forwarding.'],
    sources: [GSM_STANDARD, ORANGE_CALL_FORWARDING, T_MOBILE_CALL_FORWARDING],
  },
]
