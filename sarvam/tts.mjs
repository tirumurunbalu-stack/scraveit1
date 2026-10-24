// First Sarvam call: speak a Telugu order-confirmation line and save it as a .wav.
// Run: node --env-file=.env tts.mjs
import {writeFileSync} from "node:fs";
import {SarvamAIClient} from "sarvamai";

const apiKey = process.env.SARVAM_API_KEY;
if (!apiKey) throw new Error("SARVAM_API_KEY is not set. Put it in sarvam/.env");

const client = new SarvamAIClient({apiSubscriptionKey: apiKey});
const response = await client.textToSpeech.convert({
  text: "నమస్కారం, ఇది స్క్రేవిట్ నుండి కాల్. మీ ఆర్డర్ కన్ఫర్మ్ చేయమంటారా?",
  language_code: "te-IN",
  model: "bulbul:v3",
  speaker: "kavitha",
});

const audio = Buffer.from(response.audios[0], "base64");
writeFileSync("first-call.wav", audio);
console.log(`request_id: ${response.request_id}`);
console.log(`Saved first-call.wav (${audio.length} bytes)`);
