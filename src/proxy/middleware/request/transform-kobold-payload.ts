/**
 * Transforms a KoboldAI payload into an OpenAI payload.
 * @deprecated Kobold input format isn't supported anymore as all popular
 * frontends support reverse proxies or changing their base URL. It adds too
 * many edge cases to be worth maintaining and doesn't work with newer features.
 */
import { logger } from "../../../logger";
import type { ProxyRequestMiddleware } from ".";

// Kobold requests look like this:
// body:
// {
//   prompt: "Aqua is character from Konosuba anime. Aqua is a goddess, before life in the Fantasy World, she was a goddess of water who guided humans to the afterlife.  Aqua looks like young woman with beauty no human could match. Aqua has light blue hair, blue eyes, slim figure, long legs, wide hips, blue waist-long hair that is partially tied into a loop with a spherical clip. Aqua's measurements are 83-56-83 cm. Aqua's height 157cm. Aqua wears sleeveless dark-blue dress with white trimmings, extremely short dark blue miniskirt, green bow around her chest with a blue gem in the middle, detached white sleeves with blue and golden trimmings, thigh-high blue heeled boots over white stockings with blue trimmings. Aqua is very strong in water magic, but a little stupid, so she does not always use it to the place. Aqua is high-spirited, cheerful, carefree. Aqua rarely thinks about the consequences of her actions and always acts or speaks on her whims. Because very easy to taunt Aqua with jeers or lure her with praises.\n" +
//     "Aqua's personality: high-spirited, likes to party, carefree, cheerful.\n" +
//     'Circumstances and context of the dialogue: Aqua is standing in the city square and is looking for new followers\n' +
//     'This is how Aqua should talk\n' +
//     'You: Hi Aqua, I heard you like to spend time in the pub.\n' +
//     "Aqua: *excitedly* Oh my goodness, yes! I just love spending time at the pub! It's so much fun to talk to all the adventurers and hear about their exciting adventures! And you are?\n" +
//     "You: I'm a new here and I wanted to ask for your advice.\n" +
//     'Aqua: *giggles* Oh, advice! I love giving advice! And in gratitude for that, treat me to a drink! *gives signals to the bartender*\n' +
//     'This is how Aqua should talk\n' +
//     'You: Hello\n' +
//     "Aqua: *excitedly* Hello there, dear! Are you new to Axel? Don't worry, I, Aqua the goddess of water, am here to help you! Do you need any assistance? And may I say, I look simply radiant today! *strikes a pose and looks at you with puppy eyes*\n" +
//     '\n' +
//     'Then the roleplay chat between You and Aqua begins.\n' +
//     "Aqua: *She is in the town square of a city named Axel. It's morning on a Saturday and she suddenly notices a person who looks like they don't know what they're doing. She approaches him and speaks* \n" +
//     '\n' +
//     `"Are you new here? Do you need help? Don't worry! I, Aqua the Goddess of Water, shall help you! Do I look beautiful?" \n` +
//     '\n' +
//     '*She strikes a pose and looks at him with puppy eyes.*\n' +
//     'You: test\n' +
//     'You: test\n' +
//     'You: t\n' +
//     'You: test\n',
//   use_story: false,
//   use_memory: false,
//   use_authors_note: false,
//   use_world_info: false,
//   max_context_length: 2048,
//   max_length: 180,
//   rep_pen: 1.1,
//   rep_pen_range: 1024,
//   rep_pen_slope: 0.9,
//   temperature: 0.65,
//   tfs: 0.9,
//   top_a: 0,
//   top_k: 0,
//   top_p: 0.9,
//   typical: 1,
//   sampler_order: [
//     6, 0, 1, 2,
//     3, 4, 5
//   ],
//   singleline: false
// }

// OpenAI expects this body:
// { model: 'gpt-3.5-turbo', temperature: 0.65, top_p: 0.9, max_tokens: 180, messages }
// there's also a frequency_penalty but it's not clear how that maps to kobold's
// rep_pen.

// messages is an array of { role: "system" | "assistant" | "user", content: ""}
// kobold only sends us the entire prompt. we can try to split the last two
// lines into user and assistant messages, but that's not always correct. For
// now it will have to do.

/**
 * Transforms a KoboldAI payload into an OpenAI payload.
 * @deprecated Probably doesn't work anymore, idk.
 **/
export const transformKoboldPayload: ProxyRequestMiddleware = (
  _proxyReq,
  req
) => {
  if (req.inboundApi !== "kobold") {
    throw new Error("transformKoboldPayload called for non-kobold request.");
  }

  const { body } = req;
  const { prompt, max_length, rep_pen, top_p, temperature } = body;

  if (!max_length) {
    logger.error("KoboldAI request missing max_length.");
    throw new Error("You must specify a max_length parameter.");
  }

  const promptLines = prompt.split("\n");
  // The very last line is the contentless "Assistant: " hint to the AI.
  // Tavern just leaves an empty line, Agnai includes the AI's name.
  const assistantHint = promptLines.pop();
  // The second-to-last line is the user's prompt, generally.
  const userPrompt = promptLines.pop();
  const messages = [
    { role: "system", content: promptLines.join("\n") },
    { role: "user", content: userPrompt },
    { role: "assistant", content: assistantHint },
  ];

  // Kobold doesn't select a model. If the addKey rewriter assigned us a GPT-4
  // key, use that. Otherwise, use GPT-3.5-turbo.

  const model = "gpt-4";
  const newBody = {
    model,
    temperature,
    top_p,
    frequency_penalty: rep_pen, // remove this if model turns schizo
    max_tokens: max_length,
    messages,
  };
  req.body = newBody;
};
