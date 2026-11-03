import { Resend } from 'resend'

function getEmailConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const apiKey = environment.RESEND_API_KEY?.trim()
  const from = environment.RESEND_FROM?.trim()

  if (!apiKey || !from) {
    throw new Error(
      'Configuração do Resend ausente. Verifique RESEND_API_KEY e RESEND_FROM.',
    )
  }

  return { apiKey, from }
}

export async function sendPasswordRecoveryCode(
  recipient: string,
  code: string,
): Promise<void> {
  if (!/^\d{6}$/.test(code)) {
    throw new Error('Código de recuperação inválido.')
  }

  const { apiKey, from } = getEmailConfiguration()
  const resend = new Resend(apiKey)

  const { error } = await resend.emails.send({
    from,
    to: [recipient],
    subject: 'Código para recuperação de senha — JUCESP',
    text: [
      'Você solicitou a recuperação de senha do sistema de logística da JUCESP.',
      '',
      `Seu código de verificação é: ${code}`,
      '',
      'O código expira em 10 minutos e pode ser utilizado uma única vez.',
      'Se você não solicitou esta recuperação, ignore este e-mail.',
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#263238">
        <h2 style="color:#034EA2">Recuperação de senha</h2>
        <p>Você solicitou a recuperação de senha do sistema de logística da JUCESP.</p>
        <p>Utilize o código abaixo para continuar:</p>
        <p style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#034EA2">${code}</p>
        <p>O código expira em <strong>10 minutos</strong> e pode ser utilizado uma única vez.</p>
        <p>Se você não solicitou esta recuperação, ignore este e-mail.</p>
      </div>
    `,
  })

  if (error) {
    throw new Error('O serviço de e-mail não conseguiu enviar a mensagem.')
  }
}
