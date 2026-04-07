import { EmailTemplateDefinition } from '../email-template.types.js';

export type SchoolAdminInviteTemplateInput = {
  schoolName: string;
  setupUrl: string;
};

export const schoolAdminInviteTemplate: EmailTemplateDefinition<SchoolAdminInviteTemplateInput> =
  {
    key: 'schoolAdminInvite',
    render: ({ schoolName, setupUrl }) => ({
      subject: `Set your ${schoolName} admin account password`,
      textContent: `School admin invitation

You have been added as an admin for ${schoolName}.

Set your password and activate your account using this link:
${setupUrl}`,
      htmlContent: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
        <h2 style="margin-bottom: 12px;">School admin invitation</h2>
        <p>You have been added as an admin for <strong>${schoolName}</strong>.</p>
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
    }),
  };
