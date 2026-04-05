type SetPasswordTemplateInput = {
  setupUrl: string;
};

export function buildSetPasswordTemplate({
  setupUrl,
}: SetPasswordTemplateInput) {
  return {
    subject: 'Set your developer account password',
    textContent: `Developer account invitation

Your developer account is ready.

Set your password and activate the account using this link:
${setupUrl}`,
    htmlContent: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
        <h2 style="margin-bottom: 12px;">Developer account invitation</h2>
        <p>Your developer account is ready.</p>
        <p>Click the button below to set your password and activate the account.</p>
        <p style="margin: 24px 0;">
          <a
            href="${setupUrl}"
            style="display: inline-block; padding: 12px 18px; background: #14532d; color: #ffffff; text-decoration: none; border-radius: 8px;"
          >
            Set password
          </a>
        </p>
        <p>If the button does not work, use this link:</p>
        <p><a href="${setupUrl}">${setupUrl}</a></p>
      </div>
    `,
  };
}
