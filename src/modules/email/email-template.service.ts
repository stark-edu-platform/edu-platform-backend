import { createLogger } from '../../utils/logger.js';
import { emailService, type EmailPayload } from './email.service.js';
import {
  emailTemplateRegistry,
  type EmailTemplateKey,
  type EmailTemplateMap,
} from './email-template.registry.js';

type SendTemplateEmailInput<TKey extends EmailTemplateKey> = {
  to: string;
  template: TKey;
  data: EmailTemplateMap[TKey];
  senderName?: string;
  senderEmail?: string;
};

class EmailTemplateService {
  private readonly logger = createLogger('email-template-service');

  async sendTemplate<TKey extends EmailTemplateKey>({
    to,
    template,
    data,
    senderName,
    senderEmail,
  }: SendTemplateEmailInput<TKey>) {
    const renderedTemplate = emailTemplateRegistry[template].render(data);

    this.logger.info('Resolved email template.', {
      template,
      recipientEmail: to.trim().toLowerCase(),
      source: 'code',
    });

    return emailService.send({
      to,
      subject: renderedTemplate.subject,
      htmlContent: renderedTemplate.htmlContent,
      textContent: renderedTemplate.textContent,
      senderName,
      senderEmail,
    } satisfies EmailPayload);
  }
}

export const emailTemplateService = new EmailTemplateService();
export type { SendTemplateEmailInput };
