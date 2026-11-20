// Prints the gateway route table as JSON; deploy.ps1 turns it into APIM operations.
import { ROUTES } from '../../gateway/src/routes';

process.stdout.write(JSON.stringify(ROUTES));
