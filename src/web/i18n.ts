import type { Lang } from "../shared/types";

const OWNER = "Mike Chartrand";

const en = {
  sub: "Sales flow interview",
  load_eyebrow: "Part 1 of 2",
  buyer_eyebrow: "Part 2 of 2",
  load_title: "A load becomes available",
  buyer_title: "A buyer needs a load",
  load_desc: "What you do, step by step, when you hear that a supplier or mill has material available to sell.",
  buyer_desc: "What you do, step by step, when you hear that a buyer needs material.",
  how: "First the interviewer will ask you to describe your process in your own words. Then it will go through it with you step by step: what you opened, who you wrote to, what you checked, where each number came from. Short answers are fine. Write as you would talk.",
  private: `Only you and ${OWNER} can see your answers.`,
  begin: "Start",
  send: "Send",
  retry: "Ask again",
  thinking: "Thinking…",
  answer_label: "Your answer (Ctrl+Enter to send)",
  finish_open: "I've covered everything for this part",
  finish_q: "Finish this part? Your answers will be turned into a step-by-step write-up for you to check.",
  finish_yes: "Finish and write up",
  finish_no: "Keep going",
  rv_desc: "Check that this matches what you actually do. Edit anything that's wrong, add missing steps, then confirm.",
  rv_working: "Writing up your steps…",
  rv_again: "Try again",
  examples_l: "Real examples you mentioned",
  what_l: "What you do",
  tool_l: "Tool / channel / file",
  who_l: "Who else is involved",
  info_l: "Information you look at",
  time_l: "Time / waiting",
  remove: "Remove step",
  add: "Add a step",
  var_l: "Variations (one per line)",
  pain_l: "What goes wrong or slows you down (one per line)",
  corr_l: `Anything else ${OWNER} should know about this part`,
  confirm: "Confirm this is accurate",
  saving: "Saving…",
  saved: "Saved.",
  dn_title: "Thank you",
  dn_desc: "Both parts are confirmed. You can reopen either one to make corrections.",
  edit_load: "Edit Part 1",
  edit_buyer: "Edit Part 2",
  e_session: "Your sign-in has expired. Reload the page to sign in again.",
  e_connection: "Couldn't reach the survey. Check your connection and try again.",
  e_model_unavailable: "The interviewer is busy right now. Wait a minute, then press Ask again. Your answer is saved.",
  e_model_failed: "The interviewer didn't give a usable reply. Press Ask again. Your answer is saved.",
  e_writeup_failed: "The write-up didn't come out right. Press Try again.",
  e_conflict: "This was changed in another tab or window. The latest version is now shown.",
  e_limit: "This part has reached its answer limit. Finish it and add anything missing in the write-up.",
  e_generic: "Something went wrong. Reload the page and try again.",
};

type Key = keyof typeof en;

const es: Record<Key, string> = {
  sub: "Entrevista de flujo de ventas",
  load_eyebrow: "Parte 1 de 2",
  buyer_eyebrow: "Parte 2 de 2",
  load_title: "Hay una carga disponible",
  buyer_title: "Un comprador necesita una carga",
  load_desc: "Lo que haces, paso a paso, cuando te enteras de que un proveedor o molino tiene material disponible para vender.",
  buyer_desc: "Lo que haces, paso a paso, cuando te enteras de que un comprador necesita material.",
  how: "Primero el entrevistador te pedirá que describas tu proceso con tus propias palabras. Luego lo recorrerá contigo paso a paso: qué abriste, a quién le escribiste, qué revisaste, de dónde salió cada cifra. Las respuestas cortas están bien. Escribe como hablas.",
  private: `Solo tú y ${OWNER} pueden ver tus respuestas.`,
  begin: "Empezar",
  send: "Enviar",
  retry: "Preguntar de nuevo",
  thinking: "Pensando…",
  answer_label: "Tu respuesta (Ctrl+Enter para enviar)",
  finish_open: "Ya cubrí todo en esta parte",
  finish_q: "¿Terminar esta parte? Tus respuestas se convertirán en un resumen paso a paso para que lo revises.",
  finish_yes: "Terminar y resumir",
  finish_no: "Seguir",
  rv_desc: "Revisa que esto coincida con lo que realmente haces. Corrige lo que esté mal, agrega los pasos que falten y luego confirma.",
  rv_working: "Escribiendo tus pasos…",
  rv_again: "Intentar de nuevo",
  examples_l: "Ejemplos reales que mencionaste",
  what_l: "Lo que haces",
  tool_l: "Herramienta / canal / archivo",
  who_l: "Quién más participa",
  info_l: "Información que revisas",
  time_l: "Tiempo / espera",
  remove: "Quitar paso",
  add: "Agregar un paso",
  var_l: "Variaciones (una por línea)",
  pain_l: "Qué sale mal o te frena (uno por línea)",
  corr_l: `Algo más que ${OWNER} deba saber sobre esta parte`,
  confirm: "Confirmo que es correcto",
  saving: "Guardando…",
  saved: "Guardado.",
  dn_title: "Gracias",
  dn_desc: "Las dos partes están confirmadas. Puedes abrir cualquiera para hacer correcciones.",
  edit_load: "Editar Parte 1",
  edit_buyer: "Editar Parte 2",
  e_session: "Tu sesión expiró. Recarga la página para iniciar sesión de nuevo.",
  e_connection: "No se pudo conectar con la encuesta. Revisa tu conexión e inténtalo de nuevo.",
  e_model_unavailable: "El entrevistador está ocupado en este momento. Espera un minuto y presiona Preguntar de nuevo. Tu respuesta está guardada.",
  e_model_failed: "El entrevistador no dio una respuesta útil. Presiona Preguntar de nuevo. Tu respuesta está guardada.",
  e_writeup_failed: "El resumen no salió bien. Presiona Intentar de nuevo.",
  e_conflict: "Esto se cambió en otra pestaña o ventana. Ahora se muestra la versión más reciente.",
  e_limit: "Esta parte llegó a su límite de respuestas. Termínala y agrega lo que falte en el resumen.",
  e_generic: "Algo salió mal. Recarga la página e inténtalo de nuevo.",
};

const dictionaries: Record<Lang, Record<Key, string>> = { en, es };

let current: Lang = "en";

export function setLang(lang: Lang): void {
  current = lang;
  document.documentElement.lang = lang;
}

export function t(key: Key): string {
  return dictionaries[current][key];
}

export type { Key as MessageKey };
