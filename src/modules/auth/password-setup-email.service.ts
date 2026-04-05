import { emailService } from '../email/email.service.js';
import { buildSetPasswordTemplate } from '../email/templates/set-password.template.js';

type PasswordSetupEmailInput = {
  to: string;
  setupUrl: string;
};

export async function sendPasswordSetupEmail({
  to,
  setupUrl,
}: PasswordSetupEmailInput) {
  const template = buildSetPasswordTemplate({ setupUrl });

  return emailService.send({
    to,
    subject: template.subject,
    htmlContent: template.htmlContent,
    textContent: template.textContent,
  });
}
