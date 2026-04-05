import { Resend } from 'resend';

type PasswordSetupMailInput = {
  apiKey: string;
  from: string;
  to: string;
  setupUrl: string;
};

export async function sendPasswordSetupEmail({
  apiKey,
  from,
  to,
  setupUrl,
}: PasswordSetupMailInput) {
  const resend = new Resend(apiKey);

  const { data, error } = await resend.emails.send({
    from,
    to: [to],
    subject: 'Set your developer account password',
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6;">
        <h2>Developer account invitation</h2>
        <p>Your developer account is ready.</p>
        <p>Click the button below to set your password and activate the account.</p>
        <p>
          <a href="${setupUrl}" style="display:inline-block;padding:12px 18px;background:#14532d;color:#ffffff;text-decoration:none;border-radius:8px;">
            Set password
          </a>
        </p>
        <p>If the button does not work, use this link:</p>
        <p><a href="${setupUrl}">${setupUrl}</a></p>
      </div>
    `,
    text: `Your developer account is ready. Set your password using this link: ${setupUrl}`,
  });

  if (error) {
    throw new Error(`Failed to send password setup email: ${error.message}`);
  }

  return data;
}
