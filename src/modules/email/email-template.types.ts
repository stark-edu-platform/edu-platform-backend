export type RenderedEmailTemplate = {
  subject: string;
  htmlContent: string;
  textContent?: string;
};

export type EmailTemplateDefinition<TData> = {
  key: string;
  render: (data: TData) => RenderedEmailTemplate;
};
