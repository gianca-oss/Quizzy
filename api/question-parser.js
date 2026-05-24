const MAX_QUESTIONS = 30;

function parseQuestions(responseText) {
    let questions = parseJSON(responseText);

    if (questions.length === 0) {
        questions = parseWithSeparators(responseText);
    }

    if (questions.length === 0) {
        questions = parseAlternative(responseText);
    }

    if (questions.length > MAX_QUESTIONS) {
        questions = questions.slice(0, MAX_QUESTIONS);
    }

    return questions;
}

function parseJSON(responseText) {
    try {
        // Extract JSON from response (handle markdown code blocks)
        const jsonMatch = responseText.match(/\{[\s\S]*"questions"[\s\S]*\}/);
        if (!jsonMatch) return [];

        const data = JSON.parse(jsonMatch[0]);
        if (!data.questions || !Array.isArray(data.questions)) return [];

        return data.questions
            .filter(q => q.text && q.options && Object.keys(q.options).length >= 2)
            .map((q, index) => ({
                number: index + 1,
                text: q.text,
                options: q.options
            }));
    } catch {
        return [];
    }
}

function parseWithSeparators(responseText) {
    const questions = [];
    const allBlocks = responseText.split(/---+/);
    const questionBlocks = allBlocks.filter(block =>
        block.includes('TESTO:') || block.includes('DOMANDA')
    );

    questionBlocks.forEach((block, index) => {
        const lines = block.trim().split('\n');
        const question = { number: index + 1, text: '', options: {} };

        lines.forEach(line => {
            line = line.trim();
            if (!line) return;

            if (line.toUpperCase().startsWith('TESTO:')) {
                question.text = line.substring(6).trim();
            } else if (/^A\s*[:)]/i.test(line)) {
                question.options.A = line.replace(/^A\s*[:)]\s*/i, '').trim();
            } else if (/^B\s*[:)]/i.test(line)) {
                question.options.B = line.replace(/^B\s*[:)]\s*/i, '').trim();
            } else if (/^C\s*[:)]/i.test(line)) {
                question.options.C = line.replace(/^C\s*[:)]\s*/i, '').trim();
            } else if (/^D\s*[:)]/i.test(line)) {
                question.options.D = line.replace(/^D\s*[:)]\s*/i, '').trim();
            }
        });

        if (question.text && Object.keys(question.options).length >= 2) {
            questions.push(question);
        }
    });

    return questions;
}

function parseAlternative(responseText) {
    const questions = [];
    const lines = responseText.split('\n');
    let currentQuestion = null;
    let questionNum = 0;

    lines.forEach(line => {
        line = line.trim();

        if (line.match(/^(?:DOMANDA[_ ]?\d+|(?:\d+)[.)\s])/i)) {
            if (currentQuestion?.text) {
                questions.push(currentQuestion);
            }
            questionNum++;
            currentQuestion = { number: questionNum, text: '', options: {} };
        } else if (currentQuestion) {
            if (!currentQuestion.text && line.length > 10 && !line.match(/^[A-D][):.]/i)) {
                currentQuestion.text = line;
            } else if (line.match(/^[A-D][):.]/i)) {
                const letter = line[0].toUpperCase();
                currentQuestion.options[letter] = line.substring(2).trim();
            }
        }
    });

    if (currentQuestion?.text) {
        questions.push(currentQuestion);
    }

    return questions;
}

module.exports = { parseQuestions };
