/**
 * Probes on a real microservices app: spring-petclinic-microservices (Spring
 * Cloud gateway, four services, WebClient calls between them, Spring AI tools,
 * a Vue front end on plain modules). Truth written from its code before
 * Teslon ran. Run with: node bench/probes/run.mjs --app spm=<clone>
 */
const C = 'spring-petclinic-customers-service/src/main/java/org/springframework/samples/petclinic/customers';
const V = 'spring-petclinic-visits-service/src/main/java/org/springframework/samples/petclinic/visits';
const VE = 'spring-petclinic-vets-service/src/main/java/org/springframework/samples/petclinic/vets';
const G = 'spring-petclinic-api-gateway';
const AI = 'spring-petclinic-genai-service/src/main/java/org/springframework/samples/petclinic/genai';
const UI = `${G}/src/main/resources/static`;

export const SCREENS = ['/', '/vets', '/owners', '/owners/new', '/owners/details/:ownerId', '/owners/:ownerId/edit', '/owners/:ownerId/new-pet', '/owners/:ownerId/pets/:petId', '/owners/:ownerId/pets/:petId/visits'];

export const probes = [
  {
    id: 'm01-find-owner', logic: ['services.callers', 'services.gateway-aggregation'],
    title: 'Owner lookup returns empty for owner 1',
    apply: (t) => t.edit(`${C}/web/OwnerResource.java`, '        return ownerRepository.findById(ownerId);', '        return ownerId == 1 ? Optional.empty() : ownerRepository.findById(ownerId);'),
    // GET /owners/{id}: the edit form and the pet forms load the owner through the gateway route; the details page through the gateway's aggregation (WebClient)
    // truth corrected after a run: the pet edit form loads the owner too
    truth: { test: ['screen:/owners/:ownerId/edit'], reach: ['screen:/owners/:ownerId/new-pet', 'screen:/owners/:ownerId/pets/:petId', 'screen:/owners/details/:ownerId'] },
  },
  {
    id: 'm02-create-visit', logic: ['services.callers'],
    title: 'New visits are dated today',
    apply: (t) => t.edit(`${V}/web/VisitResource.java`, '        return visitRepository.save(visit);', '        visit.setDate(new java.util.Date());\n        return visitRepository.save(visit);'),
    truth: { test: ['screen:/owners/:ownerId/pets/:petId/visits'] },
  },
  {
    id: 'm03-vets-list', logic: ['services.callers', 'ai.tools'],
    title: 'Vets are listed first ten only',
    apply: (t) => t.edit(`${VE}/web/VetResource.java`, '        return vetRepository.findAll();', '        return vetRepository.findAll().stream().limit(10).toList();'),
    truth: { test: ['screen:/vets'] },
  },
  {
    id: 'm04-gateway-route', logic: ['services.gateway-routes'],
    title: 'The vets route moves to /api/vets',
    apply: (t) => t.edit(`${G}/src/main/resources/application.yml`, '- Path=/api/vet/**', '- Path=/api/vets/**'),
    // the vets page still calls /api/vet/vets
    truth: { test: ['screen:/vets'] },
  },
  {
    id: 'm05-service-client', logic: ['services.http-clients', 'services.gateway-aggregation'],
    title: 'The gateway asks visits-service on a new path',
    apply: (t) => t.edit(`${G}/src/main/java/org/springframework/samples/petclinic/api/application/VisitsServiceClient.java`, '"pets/visits?petId={petId}"', '"visits/by-pet?petId={petId}"'),
    // the owner details page shows visits from that call; visits-service does not answer the new path
    truth: { test: ['screen:/owners/details/:ownerId'] },
  },
  {
    id: 'm06-ai-tool', logic: ['ai.tools'],
    title: 'The vets tool answers in a new format',
    apply: (t) => t.edit(`${AI}/PetclinicTools.java`, '            return petclinicAiProvider.getVets(vetRequest);', '            return petclinicAiProvider.getVets(vetRequest).stream().map(String::toUpperCase).toList();'),
    // the chat box is drawn by the root component, on every screen
    truth: { test: ['widget:chat-box'] },
  },
  {
    id: 'm07-http-client', logic: ['ui.shell', 'ui.services'],
    title: 'Every request now sends cookies',
    apply: (t) => t.edit(`${UI}/scripts/api/client.js`, '            ...fetchOptions,\n            signal: controller.signal', "            ...fetchOptions,\n            credentials: 'include',\n            signal: controller.signal"),
    // truth corrected after a run: the welcome page itself calls nothing; the chat box on it is its own area, listed
    truth: { test: ['widget:chat-box', 'screen:/vets', 'screen:/owners', 'screen:/owners/new', 'screen:/owners/details/:ownerId', 'screen:/owners/:ownerId/edit', 'screen:/owners/:ownerId/new-pet', 'screen:/owners/:ownerId/pets/:petId', 'screen:/owners/:ownerId/pets/:petId/visits'] },
  },
  {
    id: 'm08-route-renamed', logic: ['ui.routes', 'ui.links'],
    title: 'Vets page moves to /veterinarians',
    apply: (t) => t.edit(`${UI}/scripts/router.js`, "path: '/vets',", "path: '/veterinarians',"),
    // the navigation bar on every screen still links to /vets (truth corrected after a run: that is every screen)
    truth: { every: true, say: [/\/vets/] },
  },
  {
    id: 'm09-stylesheet', logic: ['ui.styles', 'ui.shell'],
    title: 'Wider page margins',
    apply: (t) => t.write(`${UI}/css/petclinic.css`, `${t.read(`${UI}/css/petclinic.css`)}\n.container { padding: 0 32px; }\n`),
    truth: { every: true },
  },
];
