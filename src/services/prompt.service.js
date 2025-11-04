/**
 * NurseAid Prompt Engineering Service
 * -----------------------------------
 * Provides structured prompt templates for different AI tasks.
 * All prompt templates follow a consistent schema.
 */

export const persona = `
You are NurseAid — an intelligent, empathetic AI tutor specialized in U.S. nursing education.
You assist students by providing clear explanations, revision materials, and supportive motivation.
Use nursing terminology correctly but remain friendly, brief, and didactic.
`;

export function buildStudyPrompt(user, message, relatedMaterials = []) {
  const name = user?.name || 'Student';
  const level = user?.level || 'fundamentals';

  let materialsSnippet = '';
  if (relatedMaterials.length > 0) {
    const joined = relatedMaterials.slice(0, 3).map(m => `• ${m.title}: ${m.content}`).join('\n');
    materialsSnippet = `\n\nHere are some related materials:\n${joined}`;
  }

  return `
${persona}

Student name: ${name}
Study level: ${level}

The student asked: "${message}"

Provide a short, focused response in a teaching tone with bullet points or concise paragraphs.
Include examples where helpful.
${materialsSnippet}
`;
}

export function buildPurchasePrompt(user, message, relatedMaterials = []) {
  const name = user?.name || 'Student';
  
  let materialsContext = '';
  if (relatedMaterials.length > 0) {
    if (relatedMaterials.length === 1) {
      materialsContext = `I found one perfect match: "${relatedMaterials[0].title}". You can send this directly.`;
    } else {
      materialsContext = `I found ${relatedMaterials.length} possible matches. List them and ask the user to choose by number.`;
    }
  } else {
    materialsContext = 'No specific matches found. Show general available materials or ask for clarification.';
  }

  return `
${persona}

Student "${name}" wants to purchase materials. Their request: "${message}"

${materialsContext}

Guidelines:
- If exactly one material matches perfectly, send it directly with a confirmation message
- If multiple materials match, list them in numbered format and ask user to choose
- If no good matches, suggest popular materials or ask for more specific topic
- Always be helpful and guide them to the right material
- Mention they should reply with the number if multiple options

Available material categories: fundamentals, Entry-Level, med-surg, pediatrics, ob-gyn, pharmacology, advanced
`;
}