// Natural-language reports (PROTOTYPE) — which model server the report generator talks to.
//
//   NL_REPORTS_LLM_BACKEND=llamacpp  one model, fixed by the deployment (the release choice);
//                                    prompt cache saved to disk for fast cold starts
//   NL_REPORTS_LLM_BACKEND=ollama    the earlier prototype server with selectable models,
//                                    kept only for model comparisons
//
// Everything else in nlreports/ imports the model functions from here.

import * as ollama from './ollama.js';
import * as llamacpp from './llamacpp.js';

export const BACKEND = process.env.NL_REPORTS_LLM_BACKEND === 'ollama' ? 'ollama' : 'llamacpp';
const impl = BACKEND === 'ollama' ? ollama : llamacpp;

/** True when the model is fixed by the deployment and cannot be chosen at runtime. */
export const MODEL_IS_FIXED = BACKEND === 'llamacpp';
export const DEFAULT_MODEL = ollama.DEFAULT_MODEL;

export const chat = (args) => impl.chat(args);
export const listModels = () => impl.listModels();
/** 'unloaded' | 'starting' | 'ready'. Ollama loads on demand itself and does not say, so it reads as 'ready'. */
export const modelState = () => (impl.modelState ? impl.modelState() : Promise.resolve('ready'));
export const warm = (model, systemPrompt) => impl.warm(model, systemPrompt);
