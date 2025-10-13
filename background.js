// Background service worker
console.log('Vyzyvatel Auto-Answer background service worker loaded');

// AI Model Fallback Chains (try in order if one fails)
const TEXT_MODEL_CHAIN = [
  'llama-3.3-70b-versatile',      // Primary: Latest and best
  'llama-3.1-70b-versatile',      // Fallback 1: Previous version
  'llama3-70b-8192',              // Fallback 2: Older stable
  'mixtral-8x7b-32768',           // Fallback 3: Mixtral
  'gemma2-9b-it'                  // Fallback 4: Lighter model
];

const VISION_MODEL_CHAIN = [
  'llama-3.2-90b-vision-preview', // Primary: Best vision
  'llama-3.2-11b-vision-preview'  // Fallback: Lighter vision
];

// Helper function to convert blob to base64
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1]; // Remove data:image/jpeg;base64, prefix
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Core API call with retry and fallback
async function callGroqAPIWithFallback(apiKey, messages, hasImage, maxRetries = 3) {
  const modelChain = hasImage ? VISION_MODEL_CHAIN : TEXT_MODEL_CHAIN;
  let lastError = null;

  // Try each model in the chain
  for (let modelIndex = 0; modelIndex < modelChain.length; modelIndex++) {
    const model = modelChain[modelIndex];

    // Try each model with retries
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🤖 Attempt ${attempt}/${maxRetries} with ${model}`);

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model,
            messages: messages,
            temperature: 0.1,
            max_tokens: hasImage ? 50 : 10
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          const error = new Error(`Groq API error: ${response.status} - ${errorText}`);

          // Rate limit or server error → try next model
          if (response.status === 429 || response.status >= 500) {
            console.warn(`⚠️ ${model} failed (${response.status}), trying next model...`);
            lastError = error;
            break; // Break retry loop, try next model
          }

          throw error;
        }

        const data = await response.json();
        const answer = data.choices[0].message.content.trim();

        console.log(`✅ Success with ${model} (attempt ${attempt})`);
        return {
          success: true,
          answer: answer,
          model: model,
          attempt: attempt
        };

      } catch (error) {
        lastError = error;
        console.error(`❌ Attempt ${attempt} failed:`, error.message);

        // If not last attempt, wait with exponential backoff
        if (attempt < maxRetries) {
          const backoffTime = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          console.log(`⏳ Waiting ${backoffTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, backoffTime));
        }
      }
    }
  }

  // All models and retries failed
  console.error('❌ All models in fallback chain failed!');
  return {
    success: false,
    error: lastError ? lastError.message : 'All AI models failed'
  };
}

// Handle messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'processQuestion') {
    processQuestionWithAI(request.question, request.answers, request.imageUrl, request.topic)
      .then(answer => {
        sendResponse({ success: true, answer: answer });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Required for async response
  }
});

async function processQuestionWithAI(question, possibleAnswers, imageUrl, topicName) {
  // Get API key from storage
  const result = await chrome.storage.sync.get(['groqApiKey']);
  const apiKey = result.groqApiKey;
  const hasImage = !!imageUrl;

  if (!apiKey) {
    throw new Error('Groq API key not configured. Please set it in the extension popup.');
  }

  console.log('🤖 Processing:', topicName ? `[${topicName}]` : '', question.substring(0, 60) + '...');

  // Download and convert image to base64 if present
  let imageBase64 = null;
  if (hasImage) {
    try {
      console.log('🖼️ [IMAGE] Downloading image...');
      const imageResponse = await fetch(imageUrl);
      const imageBlob = await imageResponse.blob();
      imageBase64 = await blobToBase64(imageBlob);
      console.log('🖼️ [IMAGE] Image downloaded and converted to base64');
    } catch (error) {
      console.error('🖼️ [IMAGE] Failed to download image:', error);
      // Continue without image
    }
  }

  // Prepare system prompt and user prompt
  let systemPrompt = '';
  let userPrompt = '';

  // Build context with topic if available
  const contextPrefix = topicName ? `Topic/Category: ${topicName}\n\n` : '';

  if (possibleAnswers && possibleAnswers.length > 0) {
    // Multiple choice question
    if (hasImage && imageBase64) {
      systemPrompt = `You are a precise quiz answering system with vision capabilities. When given a multiple choice question with an image:
1. Carefully analyze the image provided
2. Read and understand the question
3. Use the topic/category as context to better understand what the question is asking about
4. Select the ONE correct answer from the provided options based on what you see in the image
5. Respond with ONLY the exact text of the correct answer
6. Do NOT add any explanations, punctuation, or extra text
7. Output ONLY the answer text exactly as it appears in the options`;

      userPrompt = `${contextPrefix}Look at the image and answer this question:\n\nQuestion: ${question}\n\nOptions:\n${possibleAnswers.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\nAnswer:`;
    } else {
      systemPrompt = `You are a precise quiz answering system. When given a multiple choice question:
1. Analyze the question carefully
2. Use the topic/category (if provided) as context to better understand what the question is asking about
3. Select the ONE correct answer from the provided options
4. Respond with ONLY the exact text of the correct answer
5. Do NOT add any explanations, punctuation, or extra text
6. Do NOT say "The answer is..." or similar phrases
7. Output ONLY the answer text exactly as it appears in the options

Example:
Topic: Mathematics
Question: What is 2+2?
Options: 1. Three 2. Four 3. Five
Your response: Four`;

      userPrompt = `${contextPrefix}Question: ${question}\n\nOptions:\n${possibleAnswers.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\nAnswer:`;
    }
  } else {
    // Numeric or text input question
    systemPrompt = `You are a quiz answering system. Answer with ONLY the EXACT COMPLETE number - nothing else.

CRITICAL RULES:
1. Output ONLY the EXACT FULL NUMBER (no text, no explanations, no thinking, no tags)
2. DO NOT use <think> tags or any other formatting
3. Use the topic/category (if provided) as context to understand what the question is asking about
4. If unsure, make an educated guess based on the topic
5. For movie/series counts: typical range is 1-15
6. For years: guess based on context
7. NEVER say "The answer is..." - just the raw number

EXTREMELY IMPORTANT - UNITS AND COMPLETE NUMBERS:
1. READ THE QUESTION CAREFULLY for units!
   - "Kolik TISÍC..." / "Kolik celých tisíc..." = answer in thousands (6, not 6000)
   - "Kolik MILIONŮ..." / "Kolik celých milionů..." = answer in millions (12, not 12000000)
   - "Kolik MILIARD..." / "Kolik celých miliard..." = answer in billions (540, not 540000000000)
   - "v tisících", "v milionech", "v miliardách" = use that unit!
   - PAY ATTENTION TO "celých" - it means the same as without "celých"!

2. If NO UNIT is specified:
   - Answer with THE COMPLETE FULL NUMBER
   - "Kolik obyvatel..." = 1300000 (not 1.3)
   - "Kolik zhlédnutí..." = 12543678 (not 12)

3. DO NOT use shortcuts like "12M" or "12 million" or "6k"
4. Match the units the question asks for!

Examples:
Question: How many planets are in our solar system?
Your response: 8

Question: How many Saw movies are there?
Your response: 10

Question: Kolik tisíc lidí bylo ukřižováno?
Your response: 6
(Question says "kolik TISÍC" so answer in thousands!)

Question: Kolik milionů obyvatel má Praha?
Your response: 1
(Question says "kolik MILIONŮ" so answer in millions!)

Question: Kolik obyvatel má Praha?
Your response: 1300000
(NO unit specified - use COMPLETE FULL NUMBER!)

Question: Kolik zhlédnutí má video?
Your response: 12543678
(NO unit specified - use COMPLETE FULL NUMBER!)

Question: Kolik zhlédnutí v milionech má video?
Your response: 12
(Question says "v milionech" so answer in millions!)

Question: Kolik celých miliard korun ukradl zloděj?
Your response: 540
(Question says "kolik celých MILIARD" so answer in billions - 540, NOT 540000000000!)

IMPORTANT: Output format must be EXACTLY: [number in requested unit] - nothing before, nothing after!`;

    userPrompt = `${contextPrefix}Question: ${question}\n\nAnswer (complete full number only):`;
  }

  try {
    // Build messages array
    const messages = [
      {
        role: 'system',
        content: systemPrompt
      }
    ];

    // Add user message with or without image
    if (hasImage && imageBase64) {
      // Vision message with image
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: userPrompt
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${imageBase64}`
            }
          }
        ]
      });
    } else {
      // Text-only message
      messages.push({
        role: 'user',
        content: userPrompt
      });
    }

    // Call AI with fallback chain and retry logic
    const result = await callGroqAPIWithFallback(apiKey, messages, hasImage);

    if (!result.success) {
      throw new Error(result.error);
    }

    console.log('✅ AI Response:', result.answer, `[${result.model}]`);
    return result.answer;
  } catch (error) {
    console.error('Error calling OpenRouter API:', error);
    throw error;
  }
}

// Install/update handler
chrome.runtime.onInstalled.addListener(() => {
  console.log('Extension installed/updated');
  // Set default values
  // Extension installed/updated - no default API key for security
  console.log('Extension ready. Please configure your Groq API key in the popup.');
});
