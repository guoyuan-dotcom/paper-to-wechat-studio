const {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun
} = require('docx');

function safeList(items) {
  return Array.isArray(items) ? items.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function textParagraph(text, options = {}) {
  return new Paragraph({
    children: [
      new TextRun({
        text: String(text || ''),
        bold: Boolean(options.bold),
        color: options.color || '1F2328',
        size: options.size || 24
      })
    ],
    alignment: options.alignment || AlignmentType.LEFT,
    spacing: options.spacing || { after: 180, line: 360 },
    indent: options.indent || (options.noIndent ? undefined : { firstLine: 480 }),
    border: options.border,
    shading: options.shading
  });
}

function sectionHeading(text) {
  return new Paragraph({
    children: [
      new TextRun({
        text: String(text || ''),
        bold: true,
        color: '10243E',
        size: 28
      })
    ],
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 320, after: 160 },
    border: {
      left: {
        color: 'ED7D31',
        style: BorderStyle.SINGLE,
        size: 12
      }
    },
    shading: {
      fill: 'F3F6FB'
    }
  });
}

function bulletParagraphs(items) {
  return safeList(items).map((item) => new Paragraph({
    children: [
      new TextRun({
        text: item,
        size: 24,
        color: '1F2328'
      })
    ],
    bullet: { level: 0 },
    spacing: { after: 140, line: 340 }
  }));
}

function splitIntoParagraphs(text) {
  const directParagraphs = String(text || '')
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (directParagraphs.length > 1) {
    return directParagraphs;
  }

  const sentences = String(text || '').match(/[^。！？!?]+[。！？!?]?/g) || [];
  const groups = [];
  for (let index = 0; index < sentences.length; index += 3) {
    groups.push(sentences.slice(index, index + 3).join('').trim());
  }

  return groups.filter(Boolean);
}

async function buildDocxBuffer({ title, article, metadata, keywords, post }) {
  const keywordLine = safeList(keywords).join(' / ');
  const summaryParagraphs = splitIntoParagraphs(post);

  const children = [
    textParagraph(title, {
      bold: true,
      size: 36,
      color: '10243E',
      alignment: AlignmentType.CENTER,
      spacing: { after: 260, line: 420 },
      noIndent: true
    }),
    textParagraph(article.lead, {
      size: 24,
      color: '404040',
      noIndent: true,
      spacing: { after: 220, line: 360 }
    }),
    textParagraph(`核心亮点：${article.coreHighlight}`, {
      bold: true,
      color: 'C45911',
      noIndent: true,
      spacing: { after: 220, line: 340 },
      border: {
        top: { color: 'F4B084', style: BorderStyle.SINGLE, size: 8 },
        bottom: { color: 'F4B084', style: BorderStyle.SINGLE, size: 8 },
        left: { color: 'ED7D31', style: BorderStyle.SINGLE, size: 12 },
        right: { color: 'F4B084', style: BorderStyle.SINGLE, size: 8 }
      },
      shading: { fill: 'FEF2E8' }
    }),
    ...(summaryParagraphs.length > 0
      ? [
          sectionHeading('长稿正文'),
          ...summaryParagraphs.map((paragraph) => textParagraph(paragraph, {
            spacing: { after: 180, line: 360 }
          }))
        ]
      : []),
    sectionHeading('背景与问题'),
    ...bulletParagraphs(article.background),
    sectionHeading('方法与思路'),
    ...bulletParagraphs(article.method),
    sectionHeading('关键结果'),
    ...bulletParagraphs(article.results),
    sectionHeading('论文信息'),
    ...bulletParagraphs([
      `标题：${metadata.title}`,
      `作者：${metadata.authors || '未稳定识别'}`,
      `期刊/来源：${metadata.journal || '未稳定识别'}`,
      `DOI：${metadata.doi || '未稳定识别'}`,
      `关键词：${keywordLine || '未稳定识别'}`
    ]),
    sectionHeading('结语'),
    textParagraph(article.takeaway, {
      spacing: { after: 240, line: 360 }
    }),
    textParagraph('这份 Word 稿优先保证基于论文原文，不做虚构补充。你可以继续补图、补公式和补实验点评。', {
      size: 22,
      color: '4B5563',
      noIndent: true,
      spacing: { after: 120, line: 320 }
    }),
    textParagraph(`标签：${safeList(keywords).map((item) => `#${item}`).join(' ')}`, {
      bold: true,
      color: '2E75B6',
      noIndent: true,
      spacing: { after: 80, line: 300 }
    })
  ];

  const document = new Document({
    creator: 'Research Workbench',
    title,
    description: 'Paper to Word article',
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440,
              right: 1200,
              bottom: 1440,
              left: 1200
            }
          }
        },
        children
      }
    ]
  });

  return Packer.toBuffer(document);
}

module.exports = {
  buildDocxBuffer
};
