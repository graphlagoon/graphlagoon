# Conectar o Graph Lagoon ao Amazon Neptune — um guia por tipo de autenticação

> Vale para o código atual (`main` e `feature/investigations`). Nenhum dos casos
> abaixo exige mudança de código: todos são configuração.

## Como funciona hoje (leia antes)

- A conexão com o Neptune é **do servidor**: um cluster por deployment,
  compartilhado por todos os usuários. Um contexto só registra que é do tipo
  `neptune`.
- O Neptune só tem **duas** formas nativas de acesso ao banco:
  1. **Sem autenticação**: o acesso é controlado só pela rede (VPC e security group).
  2. **IAM**: cada requisição é assinada com AWS SigV4.

  Não existe usuário e senha no Neptune. Por isso, aqui "outra opção de
  autenticação" quer dizer **de onde vêm as credenciais AWS** usadas para
  assinar.
- Quando `GRAPH_LAGOON_NEPTUNE_USE_IAM=true`, o Graph Lagoon pede as
  credenciais ao **default credential chain do botocore**
  ([client.py](../../api/graphlagoon/services/datasource/neptune/client.py)).
  Essa cadeia já cobre variáveis de ambiente, profile, assume-role, SSO,
  `credential_process`, EKS IRSA, ECS task role e EC2 instance profile. Para
  cada caso abaixo basta configurar a AWS do jeito padrão.

### Variáveis comuns a todos os casos

| Variável | Valor |
|---|---|
| `GRAPH_LAGOON_NEPTUNE_ENDPOINT` | host do cluster, **sem** `https://` (ex.: `meu-cluster.cluster-abc123.us-east-1.neptune.amazonaws.com`) |
| `GRAPH_LAGOON_NEPTUNE_PORT` | `8182` (padrão) |
| `GRAPH_LAGOON_NEPTUNE_USE_TLS` | `true` (padrão; `false` só para o emulador local) |
| `GRAPH_LAGOON_NEPTUNE_USE_IAM` | `true` em todos os casos com IAM |
| `GRAPH_LAGOON_NEPTUNE_REGION` | região do cluster; **obrigatória** com IAM |

E instale o extra que traz o botocore (sem ele, a primeira operação no Neptune falha):

```bash
cd api && uv sync --extra neptune-iam
```

### ⚠️ Pegadinha: as variáveis `AWS_*` não podem ficar no `api/.env`

O `api/.env` é lido pelo pydantic-settings só para as variáveis
`GRAPH_LAGOON_*`, e ele **não** exporta nada para `os.environ`. O botocore lê
`AWS_PROFILE`, `AWS_ACCESS_KEY_ID` etc. **direto do ambiente do processo**.
Então:

- `GRAPH_LAGOON_NEPTUNE_*` → pode ficar no `api/.env`.
- `AWS_*` → precisa estar no ambiente real: `export`, `env ... uvicorn`, o
  `environment:` do docker-compose, o `env:` do `app.yaml` e assim por diante.

### Permissão IAM mínima (para todos os casos com IAM)

A identidade que assina (usuário, role ou profile) precisa de uma policy como
esta:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "neptune-db:connect",
      "neptune-db:ReadDataViaQuery",
      "neptune-db:GetQueryStatus",
      "neptune-db:CancelQuery",
      "neptune-db:GetGraphSummary"
    ],
    "Resource": "arn:aws:neptune-db:us-east-1:123456789012:cluster-ABCDEFGHIJKLMNOP/*"
  }]
}
```

- O recurso usa o **Cluster Resource ID** (`cluster-XXXX`, na aba
  *Configuration* do console), **não** o nome do cluster.
- O Graph Lagoon só executa queries de leitura. Não conceda `WriteDataViaQuery`
  nem `DeleteDataViaQuery`.
- `GetGraphSummary` é opcional: sem ele, o botão **Discover** cai no modo de
  amostragem.
- O IAM auth precisa estar **habilitado no cluster** (*Modify → IAM DB
  authentication*). Se não estiver, as requisições assinadas são ignoradas e
  o cluster aceita qualquer conexão que chegue pela rede.

---

## Caso 0 — Sem autenticação (cluster sem IAM, acesso só por rede)

Quando usar: o cluster tem o IAM auth desligado e a API roda dentro da mesma
VPC, ou acessa a VPC por peering, VPN ou bastion.

```bash
GRAPH_LAGOON_NEPTUNE_ENDPOINT=meu-cluster.cluster-abc123.us-east-1.neptune.amazonaws.com
GRAPH_LAGOON_NEPTUNE_USE_IAM=false
```

Localmente, com o emulador: `make dev-neptune`. O Makefile já passa
`ENDPOINT=localhost`, `PORT=8183` e `USE_TLS=false`.

---

## Caso 1 — IAM com chaves em variáveis de ambiente (access key / secret)

Quando usar: testes rápidos, CI, ou um ambiente sem role, como Databricks Apps
e máquinas fora da AWS.

```bash
export GRAPH_LAGOON_NEPTUNE_ENDPOINT=meu-cluster.cluster-abc123.us-east-1.neptune.amazonaws.com
export GRAPH_LAGOON_NEPTUNE_USE_IAM=true
export GRAPH_LAGOON_NEPTUNE_REGION=us-east-1

export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
# só se forem credenciais temporárias (STS):
export AWS_SESSION_TOKEN=...
```

- Chaves de longo prazo (`AKIA...`) não expiram, e isso é um risco: prefira
  os casos 3 a 5.
- Com `AWS_SESSION_TOKEN` (credenciais temporárias), o servidor **não renova**
  as credenciais. Quando elas expirarem, as queries começam a falhar até um
  restart com chaves novas. Para credenciais temporárias que se renovam
  sozinhas, use o caso 3 ou o caso 6.

**Databricks Apps** (`app.yaml`), com as chaves guardadas como secrets do app:

```yaml
env:
  - name: GRAPH_LAGOON_NEPTUNE_ENDPOINT
    value: meu-cluster.cluster-abc123.us-east-1.neptune.amazonaws.com
  - name: GRAPH_LAGOON_NEPTUNE_USE_IAM
    value: "true"
  - name: GRAPH_LAGOON_NEPTUNE_REGION
    value: us-east-1
  - name: AWS_ACCESS_KEY_ID
    valueFrom: neptune-access-key      # resource do tipo secret
  - name: AWS_SECRET_ACCESS_KEY
    valueFrom: neptune-secret-key
```

---

## Caso 2 — IAM com profile nomeado (`~/.aws/credentials` / `~/.aws/config`)

Quando usar: desenvolvimento local com vários perfis AWS.

`~/.aws/credentials`:

```ini
[neptune-dev]
aws_access_key_id = AKIA...
aws_secret_access_key = ...
```

Ambiente:

```bash
export GRAPH_LAGOON_NEPTUNE_USE_IAM=true
export GRAPH_LAGOON_NEPTUNE_REGION=us-east-1
export AWS_PROFILE=neptune-dev
```

Se os arquivos estiverem em outro lugar (num container, por exemplo), aponte
para eles:

```bash
export AWS_SHARED_CREDENTIALS_FILE=/secrets/aws/credentials
export AWS_CONFIG_FILE=/secrets/aws/config
```

---

## Caso 3 — IAM com assume role (inclusive cross-account)

Quando usar: o cluster está em **outra conta AWS**, ou você quer que o Graph
Lagoon use uma role só de leitura, diferente da identidade da máquina.

O botocore faz o `sts:AssumeRole` e **renova as credenciais sozinho** antes de
expirarem. Tudo é configurado em `~/.aws/config`:

```ini
# Credenciais de origem: um profile com chaves...
[profile base]
region = us-east-1

[profile neptune-reader]
role_arn       = arn:aws:iam::999999999999:role/graphlagoon-neptune-reader
source_profile = base
external_id    = meu-external-id      # se a trust policy exigir
role_session_name = graphlagoon
region = us-east-1
```

…ou, numa máquina AWS, com a role da própria máquina como origem:

```ini
[profile neptune-reader]
role_arn          = arn:aws:iam::999999999999:role/graphlagoon-neptune-reader
credential_source = Ec2InstanceMetadata   # ou EcsContainer / Environment
```

Ambiente:

```bash
export GRAPH_LAGOON_NEPTUNE_USE_IAM=true
export GRAPH_LAGOON_NEPTUNE_REGION=us-east-1
export AWS_PROFILE=neptune-reader
```

Na conta do cluster (`999999999999`), a role
`graphlagoon-neptune-reader` precisa de:

- a **policy mínima** acima;
- uma **trust policy** que permita a identidade de origem assumi-la:

```json
{
  "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::111111111111:role/graphlagoon-app" },
  "Action": "sts:AssumeRole",
  "Condition": { "StringEquals": { "sts:ExternalId": "meu-external-id" } }
}
```

A identidade de origem, por sua vez, precisa de `sts:AssumeRole` sobre o ARN
da role.

> Cross-account também exige **rede**: o Neptune só é acessível de dentro da
> VPC dele. Você precisa de VPC peering, Transit Gateway ou PrivateLink entre
> as contas. O IAM sozinho não abre esse caminho.

---

## Caso 4 — IAM com role da instância (EC2 instance profile / ECS task role)

Quando usar: a API roda numa EC2 ou num ECS/Fargate na mesma VPC do cluster.
É a opção **recomendada**: não há chave em lugar nenhum.

1. Crie uma role com a policy mínima acima.
2. Associe essa role:
   - **EC2**: como *instance profile* da instância;
   - **ECS/Fargate**: como *task role* (`taskRoleArn` na task definition; não
     confunda com a *execution role*).
3. Configure só as variáveis do Graph Lagoon:

```bash
GRAPH_LAGOON_NEPTUNE_ENDPOINT=meu-cluster.cluster-abc123.us-east-1.neptune.amazonaws.com
GRAPH_LAGOON_NEPTUNE_USE_IAM=true
GRAPH_LAGOON_NEPTUNE_REGION=us-east-1
```

**Não** defina `AWS_ACCESS_KEY_ID` nem `AWS_PROFILE`: eles têm prioridade
sobre a role na cadeia. O botocore encontra a role via IMDS (EC2) ou via o
endpoint de credenciais do container (ECS) e a renova sozinho.

> EC2 com IMDSv2 dentro de container Docker: aumente o *hop limit* da
> instância para 2 (`aws ec2 modify-instance-metadata-options
> --http-put-response-hop-limit 2`). Com o limite padrão de 1, a requisição
> não chega ao IMDS e o erro é "No AWS credentials found".

---

## Caso 5 — IAM no Kubernetes/EKS (IRSA ou EKS Pod Identity)

Quando usar: a API roda num pod do EKS.

**IRSA:**

1. Crie uma role com a policy mínima e uma trust policy para o OIDC provider
   do cluster EKS, restrita ao service account.
2. Anote o service account:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: graphlagoon
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::111111111111:role/graphlagoon-neptune-reader
```

3. No Deployment, use `serviceAccountName: graphlagoon` e defina apenas as
   variáveis `GRAPH_LAGOON_NEPTUNE_*` (`USE_IAM=true`, `REGION`, `ENDPOINT`).

O EKS injeta `AWS_ROLE_ARN` e `AWS_WEB_IDENTITY_TOKEN_FILE`. O botocore usa
essas variáveis para chamar `AssumeRoleWithWebIdentity` e renovar as
credenciais. Você não configura nada além disso.

**EKS Pod Identity** funciona da mesma forma do lado do Graph Lagoon: crie a
*pod identity association* para o service account. O botocore 1.34+ (o mínimo
exigido pelo extra) já suporta.

---

## Caso 6 — IAM com credenciais de um sistema externo (Vault, broker, SSO)

Quando usar: as credenciais AWS vêm do HashiCorp Vault, de um broker interno
ou de um processo próprio.

### 6a — `credential_process` (qualquer fonte que um executável consiga ler)

O botocore roda o comando, lê o JSON de saída e **chama o comando de novo
antes de `Expiration`**.

`~/.aws/config`:

```ini
[profile neptune-vault]
credential_process = /usr/local/bin/aws-creds-from-vault --role neptune-reader
```

O comando deve imprimir:

```json
{
  "Version": 1,
  "AccessKeyId": "ASIA...",
  "SecretAccessKey": "...",
  "SessionToken": "...",
  "Expiration": "2026-10-22T18:00:00Z"
}
```

Ambiente: `AWS_PROFILE=neptune-vault`, `GRAPH_LAGOON_NEPTUNE_USE_IAM=true` e
`GRAPH_LAGOON_NEPTUNE_REGION=...`.

Com o Vault AWS secrets engine, o comando pode ser um script de poucas linhas
que chama `vault read aws/sts/neptune-reader` e reformata a saída.

### 6b — AWS IAM Identity Center (SSO), só para desenvolvimento local

```ini
[profile neptune-sso]
sso_session    = empresa
sso_account_id = 111111111111
sso_role_name  = NeptuneReader
region         = us-east-1

[sso-session empresa]
sso_start_url = https://empresa.awsapps.com/start
sso_region    = us-east-1
```

```bash
aws sso login --profile neptune-sso
export AWS_PROFILE=neptune-sso
```

Não serve para servidor: o login é interativo e expira.

---

## Caso 7 — Embutindo o Graph Lagoon num app Python (FastAPI / Databricks)

As mesmas opções valem quando o Graph Lagoon é montado via
`create_mountable_app`. Você pode passar as configurações do Neptune por
código, em vez de variáveis de ambiente:

```python
from graphlagoon import Settings, create_mountable_app

settings = Settings(
    neptune_endpoint="meu-cluster.cluster-abc123.us-east-1.neptune.amazonaws.com",
    neptune_use_iam=True,
    neptune_region="us-east-1",
)
app.mount("/graphlagoon", create_mountable_app(settings=settings))
```

As **credenciais AWS** continuam vindo da cadeia padrão. Se o app host busca
as credenciais por conta própria, ele precisa colocá-las no ambiente **antes**
da primeira query ao Neptune, porque o datasource é criado sob demanda:

```python
import os
os.environ["AWS_PROFILE"] = "neptune-reader"   # ou AWS_ACCESS_KEY_ID/...
```

Se o host precisa de credenciais que se renovam vindas de código Python (sem
passar por um executável), o caminho hoje é o `credential_process` do caso 6a.

---

## Caso 8 — Graph Lagoon num EKS em uma VPC, Neptune em outra VPC

São dois problemas independentes:

1. **Rede**: o pod precisa conseguir abrir TCP na porta 8182 dos IPs privados
   do Neptune. O Neptune não tem endpoint público, então sem uma ponte entre
   as VPCs a conexão dá timeout, com ou sem IAM.
2. **Credenciais**: são as mesmas do caso 5 (IRSA/Pod Identity). Só mudam se o
   Neptune também estiver em **outra conta** (veja 8.4).

Do lado do Graph Lagoon, nada muda: `GRAPH_LAGOON_NEPTUNE_ENDPOINT` continua
sendo o **hostname original do cluster**.

### 8.1 — Opção A: VPC peering (a mais simples)

Serve para 2 VPCs, na mesma conta ou entre contas, na mesma região ou entre
regiões. **Pré-requisito: os CIDRs não podem se sobrepor.**

1. Crie o peering (VPC do EKS ↔ VPC do Neptune) e aceite do outro lado.
2. Nas **route tables** das duas VPCs, adicione uma rota para o CIDR da outra
   VPC via `pcx-...`:
   - do lado do EKS: as route tables das subnets **dos pods/nodes**;
   - do lado do Neptune: as route tables das subnets do DB subnet group.
3. **Security group do Neptune**: libere TCP 8182 de entrada vindo do CIDR das
   subnets dos pods. Na mesma região, também dá para referenciar o security
   group dos nodes/pods da outra VPC. Atenção ao CNI:
   - **VPC CNI padrão**: os pods têm IP da VPC, então libere o CIDR das
     subnets onde os pods recebem IP. Com *custom networking* ou CIDR
     secundário (ex.: `100.64.0.0/16`), libere esse CIDR também e roteie-o no
     peering.
   - **Security Groups for Pods**: referencie o SG do pod.
   - **CNI overlay** (Calico/Cilium em overlay): o tráfego sai com o IP do
     node (SNAT), então libere o CIDR/SG dos nodes.
   - Com o VPC CNI, se `AWS_VPC_K8S_CNI_EXTERNALSNAT=false` (o padrão), o
     tráfego para fora da VPC do EKS também pode sair com o IP do node.
     Liberar os dois CIDRs (pods e nodes) evita dúvida.
4. **NACLs**: se não forem as padrão, liberem 8182 de ida e as portas efêmeras
   (1024–65535) de volta.
5. **DNS**: nada a fazer. O hostname `*.neptune.amazonaws.com` resolve para os
   IPs privados de qualquer lugar. Com o peering, esses IPs ficam alcançáveis.

### 8.2 — Opção B: Transit Gateway

Use quando há várias VPCs (hub-and-spoke) ou a empresa já padronizou o TGW. A
lógica é a mesma do peering: anexe as duas VPCs ao TGW, crie rotas para o CIDR
da outra VPC via `tgw-...` nas route tables das subnets, ajuste a route table
do TGW e use o **mesmo security group/NACL** do 8.1. O DNS também não precisa
de nada. Também exige CIDRs sem sobreposição.

### 8.2b — Opção B': AWS Cloud WAN

Para o Graph Lagoon, o Cloud WAN é **equivalente ao Transit Gateway**. Ele é
uma rede gerenciada (o *core network*, com *segments*) construída sobre a
mesma infraestrutura. Faz sentido quando a empresa já tem um core network, ou
quando há muitas VPCs em várias regiões e contas. Para ligar só duas VPCs,
peering é mais simples e mais barato: o Cloud WAN cobra por attachment por
hora e por GB processado.

1. **Attachments**: anexe as duas VPCs ao core network (VPC attachment
   usando subnets das AZs onde estão os pods e o Neptune).
   - **Mesmo segment**: as duas VPCs se enxergam direto.
   - **Segments diferentes** (ex.: `apps` e `data`): é preciso permitir a
     comunicação na *core network policy*, com `share-with` entre os
     segments ou uma rota de segment. Sem isso, as rotas não se propagam e
     a conexão dá timeout.
   - Se a policy usa `require-acceptance`, o attachment fica pendente até um
     admin da rede aceitar.
2. **Outra conta**: o core network é compartilhado via **AWS RAM** com a
   conta da outra VPC. Essa conta cria o attachment do lado dela.
3. **Route tables das subnets**: nas duas VPCs, adicione uma rota para o CIDR
   da outra VPC com destino o **core network** (target `core-network-arn`).
   Faça isso nas subnets dos pods/nodes do EKS e nas do DB subnet group do
   Neptune.
4. **Security group do Neptune**: libere 8182 vindo dos **CIDRs** dos
   pods/nodes, como em 8.1. Use CIDR, não referência de security group
   entre VPCs.
5. **DNS**: nada a fazer, como no peering.
6. **CIDRs não podem se sobrepor**: o Cloud WAN não faz NAT. Com
   sobreposição, a saída é a opção C (PrivateLink).

Se o tráfego entre segments passa por uma **VPC de inspeção** (AWS Network
Firewall ou um appliance):

- libere TCP 8182 nas regras do firewall;
- num firewall stateful, ative o **appliance mode** no attachment da VPC de
  inspeção, para evitar roteamento assimétrico entre AZs (sintoma: conexões
  que abrem e travam de forma intermitente);
- **não faça TLS inspection** do hostname do Neptune. O Graph Lagoon (httpx)
  valida o certificado contra o bundle do `certifi`, não contra o CA
  corporativo, e a conexão falha com erro de certificado. Coloque
  `*.neptune.amazonaws.com` na lista de exceções.

**Entre regiões:** funciona, mas o Neptune é um banco de baixa latência, e cada
query passa a pagar o RTT entre as regiões (dezenas de ms). Se puder, rode o
Graph Lagoon na região do cluster.

### 8.3 — Opção C: PrivateLink (CIDRs sobrepostos ou isolamento rígido)

Use quando os CIDRs se sobrepõem, ou quando a VPC do Neptune não pode ser
roteável a partir da VPC do EKS (só uma porta exposta, num sentido só). O
Neptune não oferece *endpoint service* nativo, então a ponte é montada à mão:

1. Na VPC do Neptune, crie um **NLB interno** com listener TCP 8182 e um
   target group do tipo **IP** com os IPs das instâncias do Neptune (writer e
   readers).
2. Crie um **VPC endpoint service** apontando para esse NLB e, na VPC do EKS,
   um **interface VPC endpoint** para ele.
3. **Obrigatório: faça o hostname do cluster resolver para o endpoint.** Crie
   uma **Route 53 private hosted zone**, associada à VPC do EKS, com um
   registro para o hostname exato do cluster (ex.:
   `meu-cluster.cluster-abc123.us-east-1.neptune.amazonaws.com`) apontando
   para o DNS do interface endpoint.

   O motivo:
   - **TLS**: o certificado do Neptune vale para `*.neptune.amazonaws.com`.
     Conectar pelo DNS do endpoint (`vpce-...`) falha na verificação.
     **Não** desligue `GRAPH_LAGOON_NEPTUNE_TLS_VERIFY` para contornar isso.
   - **SigV4**: o Graph Lagoon assina o header `Host` com o valor de
     `GRAPH_LAGOON_NEPTUNE_ENDPOINT:PORT`, e o Neptune valida a assinatura
     contra o host do cluster. Com a private hosted zone, o pod conecta no
     endpoint, mas envia e assina o hostname original. TLS e assinatura
     batem.
4. Mantenha os targets do NLB atualizados. Os IPs das instâncias do Neptune
   **mudam** em failover, restart e troca de instância. A solução usual é uma
   Lambda agendada (ou disparada por evento do Neptune/RDS) que resolve os
   endpoints do cluster e atualiza o target group. Sem isso, a conexão para
   de funcionar no primeiro failover.
5. Security group do Neptune: libere 8182 vindo do **NLB** (os IPs do NLB ou o
   SG do NLB, se ele tiver um), não dos pods.

É a opção com mais peças móveis. Use só se A ou B não forem possíveis.

> **E um bastion em vez disso?** Para o EKS em produção, não resolve. O pod
> ainda precisa alcançar o bastion, e isso exige peering/TGW (aí basta ir
> direto ao Neptune) ou um IP público no bastion (aí o Neptune fica exposto
> à internet). Um proxy TCP num bastion também é um NLB pior: ponto único de
> falha e sem health check. O bastion serve para acesso **de desenvolvimento**,
> descrito no caso 9.

### 8.4 — Credenciais quando o Neptune está em outra conta

O Neptune não tem resource policy. Por isso a identidade que assina precisa
**pertencer à conta do cluster**, ou assumir uma role nela. Há dois jeitos,
ambos sem chave fixa:

**(a) IRSA direto numa role da conta do Neptune**, sem encadeamento:

1. Na **conta do Neptune** (B), crie um *IAM OIDC identity provider* com a
   **mesma issuer URL** do cluster EKS da conta A
   (`aws eks describe-cluster --name <eks> --query cluster.identity.oidc.issuer`).
2. Na conta B, crie a role com a policy mínima e esta trust policy:

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::<CONTA_B>:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/<ID>" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "oidc.eks.us-east-1.amazonaws.com/id/<ID>:sub": "system:serviceaccount:<namespace>:graphlagoon",
      "oidc.eks.us-east-1.amazonaws.com/id/<ID>:aud": "sts.amazonaws.com"
    }
  }
}
```

3. Anote o service account com o ARN **da role da conta B**
   (`eks.amazonaws.com/role-arn: arn:aws:iam::<CONTA_B>:role/...`). O resto
   segue igual ao caso 5.

**(b) Encadeamento**: o IRSA dá uma role na conta A, e um profile assume a role
da conta B (o caso 3 com origem web identity). Monte um `~/.aws/config` via
ConfigMap:

```ini
[profile irsa]
role_arn = arn:aws:iam::<CONTA_A>:role/graphlagoon-irsa
web_identity_token_file = /var/run/secrets/eks.amazonaws.com/serviceaccount/token

[profile neptune-b]
role_arn = arn:aws:iam::<CONTA_B>:role/graphlagoon-neptune-reader
source_profile = irsa
region = us-east-1
```

No container, defina `AWS_CONFIG_FILE=/etc/aws/config` (o caminho do
ConfigMap montado) e `AWS_PROFILE=neptune-b`. A role da conta A precisa de
`sts:AssumeRole` na role da conta B, e a role B precisa confiar na role A.

Prefira o (a): menos peças e um único `AssumeRole`.

Em todos os casos, `GRAPH_LAGOON_NEPTUNE_REGION` é a **região do cluster
Neptune**, não a do EKS.

### 8.5 — Testando de dentro do cluster

Antes de mexer no Graph Lagoon, rode um pod de teste no mesmo namespace/nodes:

```bash
kubectl run netcheck -it --rm --restart=Never --image=curlimages/curl -- \
  sh -c 'nslookup meu-cluster.cluster-abc123.us-east-1.neptune.amazonaws.com; \
         curl -sv --max-time 10 https://meu-cluster.cluster-abc123.us-east-1.neptune.amazonaws.com:8182/status'
```

| Resultado | Significa |
|---|---|
| `nslookup` devolve IP privado da VPC do Neptune (ou do endpoint, na opção C) | DNS ok |
| `curl` dá **timeout** | Rede: rota, security group ou NACL |
| `curl` dá erro de **certificado** | Opção C sem a private hosted zone (conectando pelo nome errado) |
| `curl` responde **HTTP 403** `AccessDeniedException` | **Rede ok.** É o esperado sem assinatura num cluster com IAM. Daqui em diante o problema, se houver, é de credencial |
| `curl` responde **200** com o status | Rede ok e cluster sem IAM auth |

---

## Caso 9 — Graph Lagoon local (laptop/WSL) acessando o Neptune por um bastion

Quando usar: desenvolvimento ou debug contra um cluster real, rodando a API
na sua máquina. O Neptune só é acessível de dentro da VPC dele, então o acesso
passa por um túnel através de uma instância que está lá dentro.

### 9.1 — Abra o túnel na **mesma porta** (8182)

**SSM Session Manager** (recomendado: não precisa de porta 22 aberta nem de
chave SSH; o bastion só precisa do SSM Agent e de uma role com
`AmazonSSMManagedInstanceCore`):

```bash
aws ssm start-session --target i-0123456789abcdef0 \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["meu-cluster.cluster-abc123.us-east-1.neptune.amazonaws.com"],"portNumber":["8182"],"localPortNumber":["8182"]}'
```

(É preciso o *Session Manager plugin* instalado no laptop.)

**SSH clássico:**

```bash
ssh -N -L 8182:meu-cluster.cluster-abc123.us-east-1.neptune.amazonaws.com:8182 ec2-user@<ip-do-bastion>
```

O security group do Neptune precisa liberar 8182 vindo do **security group
do bastion**.

### 9.2 — Faça o hostname do cluster apontar para o túnel

Este é o passo que costuma ser esquecido. **Não** use
`GRAPH_LAGOON_NEPTUNE_ENDPOINT=localhost`, por dois motivos:

- **TLS**: o certificado vale para `*.neptune.amazonaws.com`, não para
  `localhost`. A verificação falha, e desligar `TLS_VERIFY` só esconde o
  problema.
- **IAM**: o Graph Lagoon assina o header `Host` com o valor do endpoint. O
  Neptune exige que esse host seja o do cluster, então `localhost:8182`
  resulta em 403.

Em vez disso, mantenha o hostname real e faça-o resolver para o túnel, no
`/etc/hosts`:

```
127.0.0.1  meu-cluster.cluster-abc123.us-east-1.neptune.amazonaws.com
```

**No WSL**, o `/etc/hosts` é regerado a cada boot. Para a linha persistir,
desligue isso em `/etc/wsl.conf`:

```ini
[network]
generateHosts = false
```

Depois rode `wsl --shutdown` no Windows. Rode o túnel **dentro do WSL**, no
mesmo lugar da API, para que `127.0.0.1` seja o mesmo dos dois lados.

### 9.3 — Configure a API normalmente

```bash
export GRAPH_LAGOON_NEPTUNE_ENDPOINT=meu-cluster.cluster-abc123.us-east-1.neptune.amazonaws.com
export GRAPH_LAGOON_NEPTUNE_PORT=8182
export GRAPH_LAGOON_NEPTUNE_USE_IAM=true        # se o cluster tiver IAM
export GRAPH_LAGOON_NEPTUNE_REGION=us-east-1
export AWS_PROFILE=neptune-dev                  # caso 2 ou 6b (SSO)
```

Para conferir: `curl -sv https://meu-cluster...:8182/status` no laptop deve
responder (HTTP 403 com IAM, 200 sem). Assim o túnel, o DNS e o TLS ficam
validados antes de subir a API.

Observações:

- Use a porta local **8182**. O `make dev-neptune` usa a 8183 para o
  emulador, então não há conflito. Se precisar de outra porta local, ajuste
  `GRAPH_LAGOON_NEPTUNE_PORT`, mas o Neptune espera o host *com a porta
  dele*. Com IAM, mantenha 8182 dos dois lados.
- Se usar o **reader endpoint**, ele precisa de outro túnel e de outra linha
  no `/etc/hosts`.
- O túnel cai quando a sessão SSM expira (o padrão é 20 min de inatividade),
  e a API passa a dar timeout até você reabrir.

---

## Caso 10 — Neptune atrás de uma Lambda (o "modo via API")

Quando usar: o time de rede **não** aceita ligar a VPC do EKS à VPC do Neptune
(nem peering, nem TGW, nem Cloud WAN), mas aceita expor **uma API**.

### 10.1 — Primeiro: a Lambda não precisa de bastion

Coloque a Lambda **dentro da VPC do Neptune**: configure a VPC e as subnets do
DB subnet group, e libere no security group do Neptune a porta 8182 vinda do
security group da Lambda. Ela fala com o Neptune direto. Um bastion no meio
só acrescenta um túnel SSH dentro da Lambda (frágil, com estado, lento no
cold start) e não resolve nada que a VPC já não resolva.

A role da Lambda assina com IAM para o Neptune (o mesmo SigV4 do caso 4) e
deve ter **só** `neptune-db:connect` e `neptune-db:ReadDataViaQuery`. Isso
importa, como explica 10.3.

### 10.2 — Isso quebra o Graph Lagoon? Depende de qual modo

A pergunta real é: qual datasource o Graph Lagoon usa para falar com a Lambda.

**Modo A — Lambda imitando o Neptune** (o datasource `neptune` aponta para a
Lambda). **Não recomendado.** Em teoria mantém tudo, mas:

- o Graph Lagoon assina o SigV4 com o serviço `neptune-db`, enquanto um
  Function URL espera `lambda` e o API Gateway espera `execute-api`. Com IAM
  ligado a assinatura não bate, e com IAM desligado o proxy fica sem
  autenticação;
- `GRAPH_LAGOON_NEPTUNE_ENDPOINT` aceita só host e porta, sem path, então não
  dá para usar o stage do API Gateway (`/prod`) sem custom domain;
- a Lambda teria de reimplementar `/openCypher`, `/openCypher/status` e
  `/pg/statistics/summary`.

**Modo B — REST connection** (o "modo via API"). **Recomendado.** O contexto
passa a ser do tipo `rest`, e a visualização inteira continua igual:
explorations, compartilhamento, layouts, comunidades, clusters, labels,
snapshots. O que muda:

| | Datasource `neptune` (direto) | REST connection via Lambda |
|---|---|---|
| Rede EKS → Neptune | precisa (caso 8) | **não precisa**: só EKS → API |
| Configuração | variáveis de ambiente | **código Python** no app host (`create_mountable_app(rest_connections=[...])`) |
| Guarda read-only | o Graph Lagoon valida o openCypher | **não existe** no Graph Lagoon. A garantia passa a ser a IAM da Lambda (`ReadDataViaQuery` apenas) |
| Validação no editor ("começa com MATCH", "RETURN r") | sim | não. O erro vem da Lambda (`REST_REMOTE_ERROR`) |
| Query console com projeções (`RETURN n.name, count(*)`) | sim, vira tabela | **não**: o console só mostra os **nós** retornados, um por linha. Agregações não aparecem |
| Expand / subgraph inicial / fetch por id / Discover | automáticos | só se você declarar os *builders* (10.4) |
| Query de exemplo | gerada pelo schema | a que você puser em `example_query` |
| Limite de resposta | o que o Neptune devolver | **6 MB** (resposta síncrona da Lambda) e **29 s** de timeout padrão do API Gateway |
| Cancelar query | best-effort no Neptune | só derruba a requisição; a Lambda e o Neptune seguem |

O openCypher em si **não** quebra: o texto que o usuário digita é repassado
como está, e a Lambda executa no Neptune.

### 10.3 — Arquitetura recomendada

```
EKS (VPC A) ──► interface VPC endpoint (execute-api) ──► API Gateway PRIVADO
                                                              │
                                                              ▼
                                            Lambda (na VPC B, do Neptune)
                                                              │ SigV4 neptune-db
                                                              ▼
                                                           Neptune
```

- **API Gateway REST do tipo PRIVATE**, com um *interface VPC endpoint*
  `com.amazonaws.<região>.execute-api` na VPC do EKS. Esse caminho usa
  PrivateLink gerenciado pela AWS: não precisa de peering, os CIDRs podem se
  sobrepor e nada sai para a internet.
- **Resource policy** da API: permitir só `aws:SourceVpce = vpce-...` (o
  endpoint do EKS).
- **Autenticação Graph Lagoon → API**: a REST connection **não consegue**
  assinar SigV4. O `headers_provider` não recebe a URL nem o body, e a
  assinatura precisa dos dois. Por isso, use a resource policy acima somada a
  um token num header (API key do API Gateway, ou um segredo que a Lambda
  confere), lido do Secrets Manager.
- **Evite Function URL com `AuthType NONE`**: ela é pública na internet e,
  protegida só por um header, dá a qualquer um com o segredo uma porta para o
  seu Neptune.

### 10.4 — A Lambda: um passthrough fino

Mantenha a lógica no Graph Lagoon e deixe a Lambda burra: ela recebe
openCypher, assina, repassa ao Neptune e devolve o JSON cru. A única rota
extra é `/schema`, para o botão Discover. O runtime Python da Lambda já traz o
botocore.

```python
# lambda_function.py — runtime python3.12, na VPC do Neptune
import json, os, urllib.error, urllib.request
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.session import Session

URL = f"https://{os.environ['NEPTUNE_ENDPOINT']}:8182/openCypher"
REGION = os.environ["AWS_REGION"]
TOKEN = os.environ["API_TOKEN"]          # melhor: ler do Secrets Manager
_creds = Session().get_credentials()     # a role da Lambda
SAMPLE = 10000


def _cypher(query, parameters=None):
    payload = {"query": query}
    if parameters:
        payload["parameters"] = json.dumps(parameters)  # o Neptune quer string
    data = json.dumps(payload).encode()
    req = AWSRequest(method="POST", url=URL, data=data,
                     headers={"Content-Type": "application/json"})
    SigV4Auth(_creds.get_frozen_credentials(), "neptune-db", REGION).add_auth(req)
    http = urllib.request.Request(URL, data=data, headers=dict(req.headers), method="POST")
    with urllib.request.urlopen(http, timeout=25) as r:
        return json.loads(r.read())


def _reply(status, body):
    return {"statusCode": status, "headers": {"Content-Type": "application/json"},
            "body": json.dumps(body)}


def lambda_handler(event, context):
    if (event.get("headers") or {}).get("x-api-token") != TOKEN:
        return _reply(401, {"detail": "unauthorized"})
    body = json.loads(event.get("body") or "{}")
    try:
        if event.get("path", "").endswith("/schema"):
            labels = _cypher(f"MATCH (n) WITH n LIMIT {SAMPLE} "
                             "UNWIND labels(n) AS l RETURN DISTINCT l")["results"]
            types = _cypher(f"MATCH ()-[r]->() WITH r LIMIT {SAMPLE} "
                            "RETURN DISTINCT type(r) AS l")["results"]
            return _reply(200, {
                "node_types": sorted({r["l"] for r in labels if r.get("l")}),
                "relationship_types": sorted({r["l"] for r in types if r.get("l")}),
            })
        # /query: openCypher -> resultado cru do Neptune ({"results": [...]})
        return _reply(200, _cypher(body.get("query", ""), body.get("parameters")))
    except urllib.error.HTTPError as e:   # erro do Neptune (query inválida, 403...)
        return _reply(400 if e.code < 500 else 502, {"detail": e.read().decode()})
```

Variáveis da Lambda: `NEPTUNE_ENDPOINT` (host do cluster) e `API_TOKEN`.
Ajuste o timeout da Lambda para ~28 s, abaixo dos 29 s do API Gateway.

### 10.5 — O lado do Graph Lagoon: a REST connection

No app que monta o Graph Lagoon, o `response_mapper` reaproveita o **mesmo
mapeamento** que o datasource Neptune usa (`map_graph_results`). Assim o
resultado cru do Neptune vira o grafo do jeito de sempre, e os *builders*
geram o openCypher das operações prontas, enviado para a mesma rota `/query`:

```python
import os
from graphlagoon import (
    RestConnectionSpec, RestConnectionUI, RestRequest, create_mountable_app,
)
from graphlagoon.services.datasource.neptune.mapping import map_graph_results

API = "https://abc123-vpce-0a1b2c.execute-api.us-east-1.vpce.amazonaws.com/prod"


def neptune_to_contract(payload: dict) -> dict:
    nodes, edges, _ = map_graph_results(payload.get("results") or [])
    return {
        "nodes": [{"id": n.node_id, "label": n.node_type,
                   "properties": n.properties or {}} for n in nodes.values()],
        "edges": [{"id": e.edge_id, "source": e.src, "target": e.dst,
                   "label": e.relationship_type,
                   "properties": e.properties or {}} for e in edges.values()],
    }


def cypher(query: str, **parameters) -> RestRequest:
    return RestRequest(path="/query",
                       json_body={"query": query, "parameters": parameters})


def expand(r):
    arrow = "->" if r.directed else "-"
    return cypher(f"MATCH p = (s)-[*1..{r.depth}]{arrow}(m) "
                  f"WHERE id(s) = $node_id RETURN p LIMIT {r.edge_limit}",
                  node_id=r.node_id)


neptune_api = RestConnectionSpec(
    name="neptune-api",
    ui=RestConnectionUI(
        label="Amazon Neptune (via API)",
        kind="REST API",
        tagline="Operational (OLTP) · low latency",
        description="O grafo operacional do Neptune, servido por uma API privada.",
        caveat="Pode não ter o quadro analítico completo; respostas acima de 6 MB falham.",
        query_language="openCypher",
        query_placeholder="MATCH (a)-[r]->(b) RETURN a, r, b LIMIT 50",
        example_query="MATCH (a)-[r]->(b) RETURN a, r, b LIMIT 50",
    ),
    base_url=API,                       # o path do stage (/prod) é aceito aqui
    headers_provider=lambda: {"x-api-token": os.environ["NEPTUNE_API_TOKEN"]},
    timeout_seconds=29,
    response_mapper=neptune_to_contract,  # vale para query e para expand/subgraph/fetch
    expand_builder=expand,
    subgraph_builder=lambda r: cypher(
        f"MATCH (a)-[r]->(b) RETURN a, r, b LIMIT {min(r.edge_limit, 2000)}"),
    fetch_nodes_builder=lambda ids: cypher(
        "MATCH (n) WHERE id(n) IN $ids RETURN n", ids=list(ids)),
    discover_types_builder=lambda r: RestRequest(path="/schema", method="POST"),
)

app.mount("/graphlagoon", create_mountable_app(rest_connections=[neptune_api]))
```

Notas:

- `map_graph_results` é um módulo **interno** do Graph Lagoon, não faz parte
  da API pública. Funciona, mas revise depois de upgrades.
- Peça `a, r, b` (ou `p`) nas queries. Se a query retorna só `r`, os nós das
  pontas viram *placeholders* sem label: o datasource Neptune busca esses nós
  numa segunda query, a REST connection não.
- Inclua sempre um `LIMIT`. O Graph Lagoon passa `limits` no body e corta o
  resultado depois, mas o limite de 6 MB da Lambda vem antes.
- Cada clique (expand, abrir contexto) vira uma invocação da Lambda. Com
  vários usuários, considere *provisioned concurrency* para evitar cold
  start.

### 10.6 — Quando NÃO fazer isso

Se a rede for possível (caso 8), use o datasource `neptune` direto. Você fica
com menos peças, mantém a guarda read-only, as projeções no console, o
discovery pelo summary do cluster e nenhum limite de 6 MB/29 s. A Lambda é a
saída para quando a única coisa permitida entre as VPCs é uma API.

---

## Qual escolher

| Onde a API roda | Recomendado |
|---|---|
| EC2 / ECS / Fargate | **Caso 4** (role da instância/task) |
| EKS | **Caso 5** (IRSA / Pod Identity) |
| EKS numa VPC, Neptune em outra | **Caso 8**: peering, TGW ou Cloud WAN (se já existir) para a rede, mais o caso 5 (ou 8.4, se for outra conta) |
| Cluster em outra conta | **Caso 3** (assume role) somado ao caso 4 ou 5 como origem |
| Fora da AWS / Databricks Apps | **Caso 6a** (`credential_process`) ou **caso 1** com chaves em secret |
| Dev local | **Caso 2** (profile) ou **caso 6b** (SSO) |
| Dev local contra um cluster real numa VPC | **Caso 9** (túnel por bastion/SSM) mais o caso 2 ou 6b |
| Cluster sem IAM | **Caso 0** |
| Rede entre VPCs proibida, só API permitida | **Caso 10** (Lambda + API Gateway privado + REST connection) |

## Quando algo dá errado

| Sintoma | Causa provável |
|---|---|
| Criar contexto / primeira query falha com `botocore is required ...` (veja o log da API) | Falta `uv sync --extra neptune-iam` |
| Servidor não sobe: `neptune_region is required ...` | `USE_IAM=true` sem `GRAPH_LAGOON_NEPTUNE_REGION` |
| Criar contexto / primeira query falha com `No AWS credentials found for Neptune SigV4 signing` | `AWS_*` no `api/.env` em vez do ambiente real, role não associada ou hop limit do IMDS |
| `AccessDeniedException` / HTTP 403 | Policy sem `neptune-db:connect`/`ReadDataViaQuery`, ARN com o nome do cluster em vez do Resource ID, ou região errada |
| Timeout / connection error | Rede: a API não alcança a VPC do Neptune (security group na porta 8182, peering). Veja o teste em 8.5 |
| Erro de certificado TLS | Conectando por um nome diferente do hostname do cluster (PrivateLink sem a private hosted zone, 8.3; ou `ENDPOINT=localhost` num túnel, 9.2) |
| Funciona e depois de ~1 h passa a dar 403 | Credenciais temporárias estáticas (`AWS_SESSION_TOKEN` fixo, caso 1). Troque pelo caso 3, 4, 5 ou 6a |
| A opção "Amazon Neptune" não aparece no picker | `GRAPH_LAGOON_NEPTUNE_ENDPOINT` não definido, ou a API não foi reiniciada |

## O que **não** é possível hoje

- **Mais de um cluster Neptune**, ou credenciais diferentes por contexto. A
  conexão é única por servidor.
- **Token/bearer para um proxy** na frente do Neptune. O cliente Neptune não
  aceita headers extras. Se houver um gateway próprio, registre-o como
  [REST connection](../guide/rest-connections.md): o `headers_provider` serve
  justamente para isso.
- **Usuário e senha**: o Neptune não tem esse modo.
