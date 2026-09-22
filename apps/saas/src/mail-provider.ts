export interface MailProvider{send(email:string,code:string):Promise<void>}
export class TestMailProvider implements MailProvider{lastCode?:string;async send(_email:string,code:string){this.lastCode=code;}}
