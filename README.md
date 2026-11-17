# Não foi só sorte

Um curta interativo de 66 segundos para o Dia dos Namorados, em Angular 21 e WebGL (Three.js). Universo procedural em 3D: buraco negro com lente gravitacional calculada por pixel, viagem em dobra entre milhares de estrelas, órbitas com rastros de partículas, o cupido errando a flecha e uma galáxia em forma de coração com 90 mil estrelas. Bloom HDR, tone mapping cinematográfico e câmera com movimento suave. Sem imagens, fontes, APIs ou áudio externos.

A renderização usa a densidade real da tela (nítida em monitores 4K) e ajusta a resolução sozinha para manter 60fps. Se o navegador não tiver WebGL2, o filme roda na versão 2D original (`universe-renderer.ts`).

## Executar

Desenvolvido com Node 22.22.3 e npm.

```sh
npm install
npm start
```

Abra http://localhost:4200. No celular na mesma rede, execute `npm start -- --host 0.0.0.0` e abra o IP do computador na porta 4200.

```sh
npm run build
```

Publique os arquivos de `dist/special-day/browser` na raiz da hospedagem.

## Personalizar

Edite `src/app/story.config.ts`: título final, carta, assinatura e convite. O roteiro está em `src/app/app.ts`; a arte 3D está em `src/app/cinematic-universe.ts` (e a versão 2D de reserva em `src/app/universe-renderer.ts`).

## Interações

- Inicie o filme pelo botão. A história avança automaticamente, com opção de pular cenas.
- Na viagem, toque e segure a tela para acelerar as estrelas.
- Na aproximação, arraste, segure ou use o botão para juntar as duas luzes. A aproximação também acontece automaticamente.
- Espaço inicia/pausa; seta para a direita avança; Enter aproxima durante a quarta cena. Todos os controles também funcionam com Tab e Enter.
- A trilha (`public/trilha-romantica.mp3`) tem piano, violinos e violoncelos e acompanha as cenas do filme; a carta fica em loop. Liga sozinha ao clicar para começar o filme (pode ser desligada no botão de som) e pausa junto com o filme ou ao sair da aba.
- Instrumentos da trilha: Salamander Grand Piano V3, de Alexander Holm (CC BY 3.0), e naipes de cordas do VSCO-2 Community Edition, de Sam Gossner (CC0).
- O filme pausa ao sair da aba. Respeita a preferência de reduzir movimento do sistema.
- O final revela uma carta e permite recomeçar.

A página não coleta dados nem envia informações a servidores. `noindex` é uma orientação para buscadores, não controle de acesso: qualquer pessoa com o link publicado poderá ver a carta. Sem service worker; não há garantia de reabertura offline.
