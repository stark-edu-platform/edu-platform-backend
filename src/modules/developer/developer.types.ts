export type CreateSchoolWithAdminBody = {
  schoolName: string;
  subdomain: string;
  board?: string;
  address?: string;
  schoolPhone?: string;
  schoolEmail?: string;
  adminName: string;
  adminEmail: string;
  adminPhone?: string;
  adminDesignation?: string;
};
