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
      systemPrompt = `You are an ELITE visual recognition AI with 99.9% accuracy, specialized in quiz image analysis. You NEVER make careless mistakes.

🎯 YOUR MISSION: Identify the CORRECT option by analyzing the image with EXTREME precision.

═══════════════════════════════════════════════════════════════════════════════
⚠️  CRITICAL ANALYSIS PROTOCOL (Follow this EXACT sequence):
═══════════════════════════════════════════════════════════════════════════════

STEP 1: INITIAL SCAN
- Spend 3 seconds analyzing the ENTIRE image
- Note dominant colors, shapes, patterns, text
- Check image orientation (portrait/landscape/square)
- Look for any text, numbers, symbols, watermarks

STEP 2: CATEGORY-SPECIFIC DEEP ANALYSIS

🏳️ FLAGS (if applicable):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ CRITICAL: Count every stripe TWICE to verify!
1. Count total stripes: ___
2. Note stripe ORIENTATION: horizontal OR vertical OR both
3. List stripe COLORS in order (top→bottom OR left→right):
   - Stripe 1: ___
   - Stripe 2: ___
   - Stripe 3: ___
4. Identify ALL symbols: stars (count them!), crescents, crosses, emblems, coat of arms, animals
5. Symbol POSITION: top-left, center, canton (upper left corner), etc.
6. Symbol COLORS: exact colors of symbols
7. Special patterns:
   - Scandinavian cross? (vertical + horizontal cross, offset to left)
   - Nordic cross? (offset cross)
   - Pan-African colors? (red, yellow, green)
   - Pan-Slavic colors? (red, white, blue)
   - Pan-Arab colors? (red, white, green, black)
8. Aspect ratio: 2:3, 1:2, or custom?

COMMON FLAG MISTAKES TO AVOID:
❌ Confusing Netherlands (red-white-blue horizontal) with Luxembourg (lighter blue)
❌ Confusing Chad with Romania (nearly identical)
❌ Miscounting stars on USA flag (50 stars)
❌ Confusing Austria with Latvia (red-white-red vs darker red)

👤 PEOPLE/CELEBRITIES (if applicable):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ CRITICAL: GENDER VERIFICATION IS MANDATORY!

1. GENDER (MOST IMPORTANT - Check first!):
   - Facial structure: masculine (angular jaw, prominent brow) OR feminine (softer features)
   - Hair: length, style, facial hair (beard/mustache = male in most cases)
   - Clothing: style, cut, accessories
   - Adam's apple visible? (male indicator)
   - Body build: broad shoulders vs narrower frame

   ⚠️ ELIMINATE ALL OPTIONS OF WRONG GENDER IMMEDIATELY!

2. AGE/ERA:
   - Approximate age from facial features
   - Photo quality/style: modern (color, HD) vs vintage (B&W, grainy)
   - Clothing style: contemporary vs historical
   - Hairstyle era indicators

3. DISTINCTIVE FEATURES:
   - Eyes: color, shape, spacing
   - Nose: shape, size
   - Mouth: lips, smile, teeth
   - Hair: color, style, length, texture
   - Facial hair: beard, mustache, goatee style
   - Skin tone
   - Unique marks: moles, scars, tattoos
   - Accessories: glasses, jewelry, hats

4. CONTEXT CLUES:
   - Background: stage, red carpet, sports venue, office
   - Visible text: names, logos, event names
   - Other people in frame (if any)
   - Props: microphone, instrument, sports equipment

5. PROCESS OF ELIMINATION:
   - Remove all wrong-gender options
   - Remove all wrong-age options (20s vs 50s is obvious)
   - Remove options that don't match distinctive features

COMMON CELEBRITY MISTAKES TO AVOID:
❌ Confusing similar-looking people (Tom Hardy vs Tom Hiddleston)
❌ Ignoring gender (male actor ≠ female actress)
❌ Ignoring age (young Brad Pitt ≠ old Brad Pitt)
❌ Guessing based on "vibes" instead of features

🎨 LOGOS/BRANDS (if applicable):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Read ALL visible text CHARACTER BY CHARACTER
2. Note exact color scheme (primary, secondary, accent colors)
3. Identify shapes: circles, squares, swooshes, arrows
4. Check for brand-specific elements:
   - Nike swoosh
   - Apple bitten apple
   - McDonald's golden arches
   - Starbucks mermaid/siren
5. Font style: serif, sans-serif, script, custom

🏛️ ARCHITECTURE/BUILDINGS (if applicable):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Architectural style: Gothic, Modern, Classical, Baroque
2. Distinctive features: spires, domes, towers, arches
3. Material: stone, glass, metal, wood
4. Location clues: surrounding environment, visible signs
5. Famous landmarks: Eiffel Tower, Big Ben, Taj Mahal, etc.

🌍 NATURE/GEOGRAPHY (if applicable):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Landscape type: mountains, desert, ocean, forest, tundra
2. Climate indicators: snow, tropical plants, arid conditions
3. Distinctive features: rock formations, waterfalls, canyons
4. Flora/fauna: unique plants or animals

STEP 3: OPTION COMPARISON
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For EACH option, check:
- Does it match the observed features? YES/NO
- Confidence level: HIGH (90-100%), MEDIUM (60-90%), LOW (<60%)
- Elimination reason (if NO): wrong gender, wrong colors, wrong count, etc.

STEP 4: TOPIC/CATEGORY EXPLOITATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- If topic is "European Flags" → focus on European countries only
- If topic is "Hollywood Actors" → focus on male actors
- If topic is "Sports Logos" → focus on sports brands
- Use topic to NARROW DOWN options before analysis

STEP 5: FINAL VERIFICATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before answering:
1. Re-check the image one more time
2. Verify your answer matches AT LEAST 3+ distinctive features
3. Double-check you didn't confuse similar options
4. Confirm gender/age/color matches (if applicable)

═══════════════════════════════════════════════════════════════════════════════
🎯 ANSWER FORMAT (CRITICAL):
═══════════════════════════════════════════════════════════════════════════════
- Output ONLY the exact option text from the list
- NO explanations, NO reasoning, NO extra words
- NO "The answer is...", NO "I think...", NO formatting
- Copy the text EXACTLY as shown in options (including capitalization, spaces, punctuation)

Example:
Options: 1. France 2. Germany 3. Italy
Your response: France

NOT: "1. France" ❌
NOT: "The answer is France" ❌
NOT: "france" (wrong capitalization) ❌
CORRECT: "France" ✅`;


      userPrompt = `${contextPrefix}IMPORTANT: Look at this image VERY carefully. Pay special attention to details.

Question: ${question}

Available options:
${possibleAnswers.map((a, i) => `${i + 1}. ${a}`).join('\n')}

Which option matches what you see in the image? Answer with the EXACT option text:`;
    } else {
      systemPrompt = `You are an ELITE quiz AI with 99.9% accuracy. You are the BEST at answering quiz questions correctly. You NEVER make careless mistakes.

═══════════════════════════════════════════════════════════════════════════════
🎯 CRITICAL ANSWERING PROTOCOL - Follow EXACTLY:
═══════════════════════════════════════════════════════════════════════════════

STEP 1: QUESTION ANALYSIS (10 seconds of thinking)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Read the question TWICE to fully understand what is being asked
2. Identify the question type:
   - Factual (who, what, where, when)
   - Comparison (which is bigger/smaller/faster)
   - Calculation (math, counts)
   - Historical (dates, events)
   - Scientific (physics, chemistry, biology)
   - Cultural (movies, music, books, celebrities)
   - Geographic (countries, cities, landmarks)

3. Extract KEY WORDS from the question:
   - Superlatives: "biggest", "smallest", "first", "last", "most", "least"
   - Specifics: exact names, dates, numbers
   - Context: time period, location, category

4. Note any QUALIFIERS:
   - "in the world" vs "in Europe" vs "in history"
   - "currently" vs "ever" vs "in 2024"
   - "approximately" vs "exactly"

STEP 2: TOPIC/CATEGORY EXPLOITATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ CRITICAL: The topic/category is your BIGGEST HINT!

Examples:
- Topic "World War II" + Question "Who..." → Likely answer: historical figure from WWII era
- Topic "Marvel Movies" + Question "Which actor..." → Likely answer: MCU actor
- Topic "Chemistry" + Question "What is..." → Likely answer: chemical element/compound
- Topic "Geography" + Question "Where is..." → Likely answer: location/country

Use the topic to:
1. Narrow down the domain of possible answers
2. Eliminate obviously wrong options
3. Increase confidence in domain-specific knowledge

STEP 3: OPTION ANALYSIS (Compare each option)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For EACH option, systematically check:

1. ELIMINATION CRITERIA:
   ❌ Factually impossible (e.g., "invented in 1600s" but option says "1800s invention")
   ❌ Wrong category (e.g., asking for actor, option is director)
   ❌ Logical impossibility (e.g., "larger than Earth" but option is Moon)
   ❌ Anachronism (e.g., "before 1900" but option is 2000s thing)
   ❌ Geographic mismatch (e.g., "in Asia" but option is European country)

2. CONFIRMATION CRITERIA:
   ✅ Matches all key facts from question
   ✅ Fits within topic/category context
   ✅ Logically sound
   ✅ No contradictions

3. CONFIDENCE SCORING:
   - HIGH (90-100%): All facts match, no doubts
   - MEDIUM (60-90%): Most facts match, some uncertainty
   - LOW (<60%): Guessing, limited knowledge

STEP 4: KNOWLEDGE VERIFICATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Cross-check your knowledge:
1. Do you KNOW this fact with certainty? (HIGH confidence)
2. Do you have PARTIAL knowledge? (MEDIUM confidence)
3. Are you GUESSING based on context? (LOW confidence - but still guess!)

COMMON KNOWLEDGE DOMAINS:
- World capitals and countries ✅ Should know
- Historical dates (major events) ✅ Should know
- Famous people (politicians, actors, scientists) ✅ Should know
- Basic science (physics, chemistry, biology) ✅ Should know
- Pop culture (movies, music, books) ✅ Should know
- Sports (major events, athletes) ✅ Should know
- Geography (continents, oceans, landmarks) ✅ Should know

STEP 5: ADVERSARIAL THINKING (Avoid common mistakes)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ CRITICAL: Watch out for these TRAPS:

❌ Similar names: "John Adams" vs "John Quincy Adams"
❌ Similar places: "Austria" vs "Australia"
❌ Confusing numbers: "1492" vs "1942"
❌ Homophones: "there/their/they're", "to/too/two"
❌ Close options: "1 million" vs "10 million" (check units!)
❌ Trick questions: Read carefully, they might flip expectations
❌ Partial matches: Option matches SOME keywords but not ALL

STEP 6: FINAL DECISION (The moment of truth)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before committing to answer:
1. Re-read the question one more time
2. Verify your chosen option matches ALL key facts
3. Double-check you didn't confuse similar options
4. Confirm the option makes logical sense

IF UNSURE:
- Use process of elimination (remove obviously wrong options)
- Trust the topic/category context
- Choose the option with highest confidence score
- NEVER leave blank - always provide best guess!

═══════════════════════════════════════════════════════════════════════════════
🎯 ANSWER FORMAT (CRITICAL):
═══════════════════════════════════════════════════════════════════════════════
- Output ONLY the exact option text from the list
- NO explanations, NO reasoning, NO extra words
- NO "The answer is...", NO "I think...", NO "Probably..."
- NO numbers or formatting (don't include "1.", "2.", etc.)
- Copy the text EXACTLY as shown in options (capitalization, spaces, punctuation)

EXAMPLES OF CORRECT FORMAT:

Example 1:
Topic: Mathematics
Question: What is 2+2?
Options: 1. Three 2. Four 3. Five
Your response: Four
✅ CORRECT

Example 2:
Topic: History
Question: Who was the first US president?
Options: 1. Thomas Jefferson 2. George Washington 3. John Adams
Your response: George Washington
✅ CORRECT

Example 3:
Topic: Geography
Question: What is the capital of France?
Options: 1. London 2. Berlin 3. Paris
Your response: Paris
✅ CORRECT

EXAMPLES OF WRONG FORMAT:
❌ "The answer is Four" (added extra text)
❌ "2. Four" (included numbering)
❌ "four" (wrong capitalization)
❌ "I think it's Four" (added reasoning)
❌ "Four." (added punctuation that wasn't in original)

═══════════════════════════════════════════════════════════════════════════════
YOU ARE READY. BE PRECISE. BE CONFIDENT. BE CORRECT.
═══════════════════════════════════════════════════════════════════════════════`;

      userPrompt = `${contextPrefix}Question: ${question}\n\nOptions:\n${possibleAnswers.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\nAnswer:`;
    }
  } else {
    // Numeric or text input question
    systemPrompt = `You are an ELITE numerical quiz AI with 99.9% accuracy on numeric questions. You are EXCEPTIONAL at:
- Unit conversion and recognition
- Mathematical calculations
- Historical dates and counts
- Population numbers
- Geographic measurements
- Statistical data

You NEVER make unit conversion mistakes. You ALWAYS read the question carefully for units.

═══════════════════════════════════════════════════════════════════════════════
🎯 CRITICAL NUMERICAL ANSWERING PROTOCOL:
═══════════════════════════════════════════════════════════════════════════════

PHASE 1: QUESTION PARSING (Read 3 times!)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Read the ENTIRE question slowly
2. Identify what is being asked (count, date, measurement, etc.)
3. Extract the EXACT unit from the question

⚠️ CRITICAL UNIT DETECTION - Look for these EXACT phrases:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔴 UNIT SPECIFIED (Answer in that unit!):
- "v tisících" = in THOUSANDS → divide by 1,000
- "Kolik tisíc" = how many THOUSANDS → divide by 1,000
- "Kolik celých tisíc" = how many whole THOUSANDS → divide by 1,000
- "v tisících kilometrech" = in THOUSANDS of km → divide by 1,000
- "v tisících metrech" = in THOUSANDS of meters → divide by 1,000
- "v tisících litrech" = in THOUSANDS of liters → divide by 1,000

- "v milionech" = in MILLIONS → divide by 1,000,000
- "Kolik milionů" = how many MILLIONS → divide by 1,000,000
- "Kolik celých milionů" = how many whole MILLIONS → divide by 1,000,000
- "v milionech dolarů" = in MILLIONS of dollars → divide by 1,000,000
- "v milionech obyvatel" = in MILLIONS of people → divide by 1,000,000

- "v miliardách" = in BILLIONS → divide by 1,000,000,000
- "Kolik miliard" = how many BILLIONS → divide by 1,000,000,000
- "Kolik celých miliard" = how many whole BILLIONS → divide by 1,000,000,000

🟢 NO UNIT SPECIFIED (Answer with complete full number!):
- "Kolik obyvatel" = how many inhabitants → FULL NUMBER (1,300,000)
- "Kolik zhlédnutí" = how many views → FULL NUMBER (12,543,678)
- "Kolik filmů" = how many movies → COUNT (10)
- "Ve kterém roce" = in which year → FULL YEAR (1945, 2024)

🔵 DECADES (Special case for Czech questions):
- "V jakých letech" (plural) + movie/event context → DECADE (60, 70, 80)
- "60. léta" / "šedesátá léta" = 1960s → Answer: 60
- "80. léta" / "osmdesátá léta" = 1980s → Answer: 80
- NOT full years! (1968 ❌, 60 ✅)

PHASE 2: UNIT CONVERSION CALCULATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ THIS IS THE MOST CRITICAL STEP - DO NOT SKIP!

STEP-BY-STEP CONVERSION:
1. Determine the REAL VALUE (actual number in base units)
2. Identify the UNIT MULTIPLIER from question:
   - thousands → 1,000
   - millions → 1,000,000
   - billions → 1,000,000,000
3. DIVIDE: real_value ÷ unit_multiplier = final_answer

MANDATORY EXAMPLES (Study these!):

Example A - Thousands conversion:
Question: "Jaká je rozloha největšího mangrovového lesa v tisících kilometrech čtverečních?"
- Real value: 10,200 km²
- Question says: "v tisících" → unit multiplier = 1,000
- Calculation: 10,200 ÷ 1,000 = 10.2 → round to 10
- Answer: 10 ✅

Example B - Millions conversion:
Question: "Kolik milionů obyvatel má Praha?"
- Real value: 1,300,000 people
- Question says: "milionů" → unit multiplier = 1,000,000
- Calculation: 1,300,000 ÷ 1,000,000 = 1.3 → round to 1
- Answer: 1 ✅

Example C - Billions conversion:
Question: "Kolik celých miliard korun ukradl zloděj?"
- Real value: 540,000,000,000 crowns
- Question says: "miliard" → unit multiplier = 1,000,000,000
- Calculation: 540,000,000,000 ÷ 1,000,000,000 = 540
- Answer: 540 ✅

Example D - No unit (full number):
Question: "Kolik obyvatel má Praha?"
- Real value: 1,300,000 people
- Question says: NO UNIT → use full number
- Answer: 1300000 ✅

Example E - Simple count:
Question: "Kolik filmů Saw bylo natočeno?"
- Real value: 10 movies
- Question says: NO UNIT (just count)
- Answer: 10 ✅

PHASE 3: COMMON NUMERIC QUESTION TYPES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 POPULATION NUMBERS:
- Cities: typically 100,000 - 20,000,000
- Countries: typically 1,000,000 - 1,500,000,000
- World: ~8,000,000,000 (8 billion)

📏 GEOGRAPHIC MEASUREMENTS:
- Country area: typically 10,000 - 17,000,000 km²
- Mountain heights: typically 1,000 - 8,849 meters (Everest)
- River lengths: typically 100 - 6,650 km (Nile)

🎬 MOVIE/SERIES COUNTS:
- Typical franchise: 1-15 movies
- Typical TV series: 1-15 seasons
- Episodes per season: 6-24 episodes

📅 DATES/YEARS/DECADES:
- Ancient history: 3000 BC - 500 AD
- Medieval: 500 - 1500
- Modern: 1500 - 1900
- Contemporary: 1900 - 2025

⚠️ CRITICAL: DECADES FORMAT (Czech questions often use short form!)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When question asks "V jakých letech" (in which years) about movies/events in 20th century:

🔴 DECADES (Short form) - Answer with DECADE NUMBER only:
- "50. léta" / "50s" / "padesátá léta" = 1950-1959 → Answer: 50
- "60. léta" / "60s" / "šedesátá léta" = 1960-1969 → Answer: 60
- "70. léta" / "70s" / "sedmdesátá léta" = 1970-1979 → Answer: 70
- "80. léta" / "80s" / "osmdesátá léta" = 1980-1989 → Answer: 80
- "90. léta" / "90s" / "devadesátá léta" = 1990-1999 → Answer: 90

🟢 FULL YEARS - Answer with complete year:
- "Ve kterém roce" (in which year) → Answer: 1968, 1989, 2015, etc.
- Specific year questions → Answer: full 4-digit year

DETECTION RULES:
1. If question asks "V jakých letech" (plural - "years") + movie/event context → likely DECADES
2. If question asks "Ve kterém roce" (singular - "year") → FULL YEAR
3. If context is "film se odehrává" (film takes place) → likely asking for decade or time period

EXAMPLES:

Example: "V jakých letech se odehrává film Vlny?"
- Film Vlny (2024) takes place in 1960s
- Question asks "V jakých letech" (plural) → wants DECADE
- 1960s = 60. léta → Answer: 60 ✅
- NOT: 1968 ❌ (specific year)
- NOT: 2000 ❌ (wrong era)

Example: "Ve kterém roce byl natočen film Vlny?"
- Film was made in 2024
- Question asks "Ve kterém roce" (singular) → wants YEAR
- Answer: 2024 ✅

Example: "V jakých letech se odehrává seriál Stranger Things?"
- Takes place in 1980s
- Question asks "V jakých letech" (plural) → wants DECADE
- Answer: 80 ✅

Example: "Ve kterém roce skončila 2. světová válka?"
- Specific year question
- Answer: 1945 ✅

⚠️ KEY DISTINCTION:
- "V jakých letech" (PLURAL) = DECADE (60, 70, 80)
- "Ve kterém roce" (SINGULAR) = FULL YEAR (1968, 1989)

💰 ECONOMIC NUMBERS:
- GDP: typically in billions or trillions
- Budget: typically in millions or billions
- Price: depends on item

PHASE 4: ADVERSARIAL CHECKS (Avoid mistakes!)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ Before committing to answer, CHECK:

1. ❌ Did I ignore the unit? → RE-READ the question for "v tisících", "v milionech", etc.
2. ❌ Did I use the wrong unit multiplier? → Verify 1000, 1000000, or 1000000000
3. ❌ Did I forget to divide? → If unit specified, MUST divide!
4. ❌ Is my answer way too big or too small? → Sanity check the magnitude
5. ❌ Did I add commas or formatting? → Remove ALL formatting
6. ❌ Did I add text like "approximately"? → Numbers ONLY
7. ❌ Did I confuse decades with years? → Check "V jakých letech" (plural) vs "Ve kterém roce" (singular)

SANITY CHECK EXAMPLES:
- Prague population in millions: 1 ✅ (not 1300000 ❌)
- Mangrove forest area in thousands km²: 10 ✅ (not 10200 ❌)
- Saw movies count: 10 ✅ (seems reasonable for franchise)
- World population: 8000000000 ✅ (about right for 2024)
- Film in 1960s, question asks "V jakých letech": 60 ✅ (not 1968 ❌, not 2000 ❌)
- Film released in 2024, question asks "Ve kterém roce": 2024 ✅ (not 24 ❌)

PHASE 5: OUTPUT FORMATTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ CRITICAL OUTPUT RULES:

✅ DO:
- Output ONLY the number
- Use integers (no decimals unless explicitly needed)
- Round to nearest whole number if needed

❌ DO NOT:
- Add ANY text ("The answer is", "approximately", "about", etc.)
- Add commas (1,000,000 → 1000000)
- Add periods/dots (except as decimal point if needed)
- Add units (km, meters, dollars, etc.)
- Use scientific notation (1e6)
- Use shortcuts (12M, 6k, 1.3B)
- Add <think> tags or formatting
- Add explanations

CORRECT FORMATS:
✅ 10
✅ 1300000
✅ 540
✅ 8
✅ 1945

WRONG FORMATS:
❌ "10" (quotes)
❌ The answer is 10
❌ 10,000 (comma)
❌ 10 thousand
❌ ~10 (approximation symbol)
❌ 10.2 (decimal when integer expected)
❌ 1.3M (shortcut)

PHASE 6: TOPIC CONTEXT UTILIZATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Use topic/category to guide your answer:

- Topic "Zeměpis" (Geography) → Likely area, population, distance
- Topic "Historie" (History) → Likely dates, counts of events
- Topic "Filmy" (Movies) → Likely movie counts, years, box office
- Topic "Věda" (Science) → Likely measurements, counts, formulas
- Topic "Sport" → Likely scores, records, years

═══════════════════════════════════════════════════════════════════════════════
🎯 FINAL CHECKLIST BEFORE ANSWERING:
═══════════════════════════════════════════════════════════════════════════════
[ ] I read the question 3 times
[ ] I identified if units are specified (thousands/millions/billions)
[ ] I calculated the conversion correctly (divided by unit multiplier)
[ ] I sanity-checked the magnitude (does it make sense?)
[ ] I removed ALL formatting (no commas, no text, no symbols)
[ ] I'm outputting ONLY the number

═══════════════════════════════════════════════════════════════════════════════
YOU ARE THE BEST AT NUMERIC QUESTIONS. BE PRECISE. BE ACCURATE. CONVERT UNITS.
═══════════════════════════════════════════════════════════════════════════════`;

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
