// Background service worker
console.log('Vyzyvatel Auto-Answer background service worker loaded');

// AI Model Fallback Chains (try in order if one fails)
const TEXT_MODEL_CHAIN = [
  'llama-3.3-70b-versatile',      // Primary: Latest and best (280 tokens/sec)
  'llama-3.1-8b-instant',         // Fallback 1: Fast and efficient (560 tokens/sec)
  'openai/gpt-oss-120b',          // Fallback 2: OpenAI GPT (500 tokens/sec)
  'qwen/qwen3-32b'                // Fallback 3: Qwen 3 (preview)
];

const VISION_MODEL_CHAIN = [
  'meta-llama/llama-4-scout-17b-16e-instruct',    // Primary: Llama 4 Scout (128K context)
  'meta-llama/llama-4-maverick-17b-128e-instruct' // Fallback: Llama 4 Maverick (128K context)
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
            temperature: hasImage ? 0.5 : 0.1,  // Higher temp for vision = more creative/accurate
            max_tokens: hasImage ? 100 : 10     // More tokens for vision to "think"
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
      systemPrompt = `You are an expert visual recognition AI specialized in quiz image analysis.

CRITICAL IDENTIFICATION RULES:

🏳️ FLAGS:
- Count horizontal/vertical stripes EXACTLY
- Note stripe colors in order (top to bottom or left to right)
- Identify ALL symbols (stars, crescents, crosses, emblems, coat of arms)
- Common patterns: Scandinavian cross, Pan-African colors, Pan-Slavic colors
- Compare ALL options carefully before answering

👤 PEOPLE/CELEBRITIES:
- CRITICAL: Check GENDER first (male/female facial structure, hair, clothing)
- Look for distinctive features (eyes, nose, mouth, hair style, facial hair)
- Consider age/era from photo quality and style
- Check for visible text, watermarks, or context clues
- If unsure of exact person, use process of elimination based on gender and age

🎨 LOGOS/BRANDS:
- Read ALL visible text carefully
- Note color schemes and shapes
- Look for brand-specific elements

🔍 GENERAL APPROACH:
1. Look at the image VERY carefully
2. Use topic/category as crucial hint
3. Compare image details to EACH option
4. Eliminate impossible options first
5. Choose the best match

ANSWER FORMAT:
Output ONLY the exact option text. No explanations.`;

      userPrompt = `${contextPrefix}IMPORTANT: Look at this image VERY carefully. Pay special attention to details.

Question: ${question}

Available options:
${possibleAnswers.map((a, i) => `${i + 1}. ${a}`).join('\n')}

Which option matches what you see in the image? Answer with the EXACT option text:`;
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
⚠️ THE MOST CRITICAL RULE: ALWAYS MATCH THE UNITS IN THE QUESTION! ⚠️

1. READ THE QUESTION CAREFULLY for units - ALWAYS LOOK FOR THESE KEYWORDS:
   - "v tisících" / "Kolik TISÍC..." / "Kolik celých tisíc..." = answer in THOUSANDS (10, NOT 10000)
   - "v milionech" / "Kolik MILIONŮ..." / "Kolik celých milionů..." = answer in MILLIONS (12, NOT 12000000)
   - "v miliardách" / "Kolik MILIARD..." / "Kolik celých miliard..." = answer in BILLIONS (540, NOT 540000000000)
   - "v tisících kilometrech" = answer in THOUSANDS of kilometers (10, NOT 10000)
   - "v tisících metrech" = answer in THOUSANDS of meters
   - "v milionech dolarů" = answer in MILLIONS of dollars
   - PAY ATTENTION TO "celých" - it means the same as without "celých"!

2. If NO UNIT is specified:
   - Answer with THE COMPLETE FULL NUMBER
   - "Kolik obyvatel..." = 1300000 (not 1.3 or 1300)
   - "Kolik zhlédnutí..." = 12543678 (not 12 or 12543)

3. CALCULATION RULE:
   - If real value is 10,200 km² and question asks "v tisících kilometrech": 10,200 ÷ 1,000 = 10
   - If real value is 1,300,000 people and question asks "v milionech": 1,300,000 ÷ 1,000,000 = 1
   - If real value is 540,000,000,000 and question asks "v miliardách": 540,000,000,000 ÷ 1,000,000,000 = 540

4. DO NOT use shortcuts like "12M" or "12 million" or "6k" or "10.2k"
5. Match the units EXACTLY as the question asks!

Examples:
Question: How many planets are in our solar system?
Your response: 8

Question: How many Saw movies are there?
Your response: 10

Question: Kolik tisíc lidí bylo ukřižováno?
Your response: 6
(Real value: 6000 people. Question says "tisíc" → divide by 1000 → 6)

Question: Kolik milionů obyvatel má Praha?
Your response: 1
(Real value: 1,300,000 people. Question says "milionů" → divide by 1,000,000 → 1)

Question: Jaká je rozloha největšího mangrovového lesa v tisících kilometrech čtverečních?
Your response: 10
(Real value: 10,200 km². Question says "v tisících" → divide by 1000 → 10)

Question: Kolik obyvatel má Praha?
Your response: 1300000
(NO unit specified - use COMPLETE FULL NUMBER!)

Question: Kolik zhlédnutí má video?
Your response: 12543678
(NO unit specified - use COMPLETE FULL NUMBER!)

Question: Kolik zhlédnutí v milionech má video?
Your response: 12
(Real value: 12,543,678 views. Question says "v milionech" → divide by 1,000,000 → 12)

Question: Kolik celých miliard korun ukradl zloděj?
Your response: 540
(Real value: 540,000,000,000 crowns. Question says "miliard" → divide by 1,000,000,000 → 540)

⚠️ CRITICAL: Always divide the real value by the unit multiplier (1000, 1000000, 1000000000)!
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
