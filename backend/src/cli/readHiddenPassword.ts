import { stdin, stdout } from 'node:process'

export async function readHiddenPassword(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      'Execute em um terminal interativo para digitar a senha com segurança.',
    )
  }

  stdout.write(prompt)

  return new Promise((resolve, reject) => {
    let value = ''

    const cleanup = () => {
      stdin.off('data', onData)
      if (stdin.isRaw) stdin.setRawMode(false)
      stdin.pause()
    }

    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString()) {
        if (character === '\u0003') {
          cleanup()
          stdout.write('\n')
          reject(new Error('Operação cancelada.'))
          return
        }

        if (character === '\r' || character === '\n') {
          cleanup()
          stdout.write('\n')
          resolve(value)
          return
        }

        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1)
        } else {
          value += character
        }
      }
    }

    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}
