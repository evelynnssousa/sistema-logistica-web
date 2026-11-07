import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveAttachmentStorage } from './storage.js'
import { AttachmentRejectedError, detectKind, sanitizeFileName, validateAttachment } from './fileValidation.js'

const rules = { maxFileMb: 1, allowedKinds: ['pdf', 'png', 'jpeg', 'webp', 'docx', 'xlsx', 'txt'] }

const png = Buffer.from('89504e470d0a1a0a00', 'hex')
const jpeg = Buffer.from('ffd8ffe000', 'hex')
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
const pdf = Buffer.from('%PDF-1.7\n%%EOF\n')

/** ZIP mínimo, só com o diretório central, suficiente para a leitura dos nomes. */
function zip(names: string[]) {
  const entries = names.map((name) => {
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(Buffer.byteLength(name), 28)
    return Buffer.concat([header, Buffer.from(name)])
  })
  const directory = Buffer.concat(entries)
  const start = Buffer.from([0x50, 0x4b, 0x03, 0x04])
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(names.length, 10)
  end.writeUInt32LE(start.length, 16)
  return Buffer.concat([start, directory, end])
}

test('o tipo vem do conteúdo', () => {
  assert.equal(detectKind(png), 'png')
  assert.equal(detectKind(jpeg), 'jpeg')
  assert.equal(detectKind(webp), 'webp')
  assert.equal(detectKind(pdf), 'pdf')
  assert.equal(detectKind(Buffer.from('Texto com acentuação')), 'txt')
  assert.equal(detectKind(zip(['[Content_Types].xml', 'word/document.xml'])), 'docx')
  assert.equal(detectKind(zip(['[Content_Types].xml', 'xl/workbook.xml'])), 'xlsx')
  assert.equal(detectKind(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0xff, 0xfe])), null)
  assert.equal(detectKind(zip(['a.txt'])), null)
})

test('recusa conteúdo ativo disfarçado', () => {
  for (const [buffer, name] of [
    [zip(['[Content_Types].xml', 'word/document.xml', 'word/vbaProject.bin']), 'a.docx'],
    [zip(['[Content_Types].xml', 'xl/workbook.xml', 'xl/embeddings/oleObject1.bin']), 'a.xlsx'],
    [Buffer.from('%PDF-1.7\n/OpenAction 1 0 R'), 'a.pdf'],
    [Buffer.from('%PDF-1.7\n/Launch'), 'a.pdf'],
    [Buffer.from('<svg onload="alert(1)"></svg>'), 'a.txt'],
    [Buffer.from('MZ\u0000\u0001'), 'a.txt'],
  ] as const) {
    assert.throws(() => validateAttachment(buffer, name, rules), AttachmentRejectedError, name)
  }
})

test('recusa extensão enganosa ou perigosa, vazio e excesso', () => {
  assert.throws(() => validateAttachment(png, 'foto.jpg', rules), /corresponde/)
  assert.throws(() => validateAttachment(pdf, 'nota.exe.pdf', rules), /não é permitido/)
  assert.throws(() => validateAttachment(Buffer.from('oi'), 'script.js', rules), /não é permitido/)
  assert.throws(() => validateAttachment(Buffer.from('<x>'), 'a.svg', rules), /não é permitido/)
  assert.throws(() => validateAttachment(Buffer.alloc(0), 'a.png', rules), /vazio/)
  assert.throws(() => validateAttachment(Buffer.alloc(2 * 1024 * 1024, 0x61), 'a.txt', rules), /limite/)
  assert.throws(() => validateAttachment(pdf, 'a.pdf', { ...rules, allowedKinds: ['png'] }), /não é permitido/)
  assert.deepEqual(validateAttachment(jpeg, 'FOTO.JPG', rules), { kind: 'jpeg', name: 'FOTO.JPG' })
})

test('o nome perde caminho e controle, e mantém a extensão ao encurtar', () => {
  assert.equal(sanitizeFileName('../../etc/passwd.txt'), 'passwd.txt')
  assert.equal(sanitizeFileName('C:\\Users\\a\\nota.pdf'), 'nota.pdf')
  assert.equal(sanitizeFileName('a\u0000b"<c>.pdf'), 'abc.pdf')
  assert.equal(sanitizeFileName('...oculto.txt'), 'oculto.txt')
  const long = sanitizeFileName(`${'x'.repeat(300)}.pdf`)
  assert.equal(long.length, 180)
  assert.ok(long.endsWith('.pdf'))
  assert.throws(() => sanitizeFileName('../'), AttachmentRejectedError)
})

test('armazenamento: sem pasta absoluta, não há armazenamento', () => {
  assert.equal(resolveAttachmentStorage({}), null)
  assert.equal(resolveAttachmentStorage({ ATTACHMENTS_DIR: 'relativo/anexos' }), null)
  assert.ok(resolveAttachmentStorage({ ATTACHMENTS_DIR: '/var/slm/anexos' }))
})

test('armazenamento: a chave nunca sai da pasta', async () => {
  const storage = resolveAttachmentStorage({ ATTACHMENTS_DIR: '/var/slm/anexos' })!
  await assert.rejects(storage.open('../../../etc/passwd'), /inválida/)
})
