<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    throw new RuntimeException('Execute este arquivo somente pelo terminal.');
}

require '/var/www/glpi/vendor/autoload.php';

$kernel = new Glpi\Kernel\Kernel();
$kernel->boot();

function api(string $method, string $path, array $headers = [], ?array $input = null, int $expected = 200): array|bool
{
    $request = curl_init('http://127.0.0.1/apirest.php/' . $path);
    curl_setopt_array($request, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_HTTPHEADER => array_merge([
            'Content-Type: application/json',
            'App-Token: ' . getenv('THEO_APP_TOKEN'),
        ], $headers),
    ]);
    if ($input !== null) {
        curl_setopt($request, CURLOPT_POSTFIELDS, json_encode($input, JSON_THROW_ON_ERROR));
    }
    $response = curl_exec($request);
    $status = curl_getinfo($request, CURLINFO_RESPONSE_CODE);
    if ($response === false || $status !== $expected) {
        throw new RuntimeException($method . ' ' . $path . ': HTTP ' . $status . ', esperado ' . $expected);
    }
    return json_decode($response, true, 512, JSON_THROW_ON_ERROR);
}

$category = new ITILCategory();
$requester = new User();
$technician = new User();
if (!$category->getFromDBByCrit(['name' => 'Geral', 'entities_id' => 0])
    || !$requester->getFromDBbyName('usuario.demo')
    || !$technician->getFromDBbyName('tecnico.demo')) {
    throw new RuntimeException('Execute seed-demo.php antes desta verificação.');
}

$sessions = [];
try {
    $unauthenticated = api('GET', 'Ticket', expected: 400);
    if (($unauthenticated[0] ?? null) !== 'ERROR_SESSION_TOKEN_MISSING') {
        throw new RuntimeException('Resposta inesperada para uma requisição sem sessão.');
    }
    $sessions[] = api('GET', 'initSession', ['Authorization: user_token ' . getenv('THEO_API_TOKEN')])['session_token'];
    $integration = ['Session-Token: ' . $sessions[0]];

    $created = api('POST', 'Ticket', $integration, ['input' => [
        'name' => 'Demonstração Theo — abertura via API',
        'content' => 'Solicitação fictícia criada para validar a integração local do Theo.',
        'entities_id' => 0,
        'itilcategories_id' => $category->getID(),
        '_users_id_requester' => $requester->getID(),
        'type' => Ticket::DEMAND_TYPE,
        'urgency' => 3,
        'impact' => 3,
    ]], expected: 201);
    $ticketId = $created['id'];

    foreach ([0 => 'Resposta pública de demonstração.', 1 => 'Nota interna de demonstração.'] as $private => $content) {
        api('POST', 'ITILFollowup', $integration, ['input' => [
            'itemtype' => 'Ticket',
            'items_id' => $ticketId,
            'content' => $content,
            'is_private' => $private,
        ]], expected: 201);
    }
    api('PUT', 'Ticket/' . $ticketId, $integration, ['input' => [
        'id' => $ticketId,
        'status' => Ticket::ASSIGNED,
        '_users_id_assign' => $technician->getID(),
    ]]);

    $sessions[] = api('GET', 'initSession', [
        'Authorization: Basic ' . base64_encode('usuario.demo:' . getenv('THEO_USER_PASSWORD')),
    ])['session_token'];
    $userHeaders = ['Session-Token: ' . $sessions[1]];
    $ticket = api('GET', 'Ticket/' . $ticketId, $userHeaders);
    if ((int) $ticket['itilcategories_id'] !== $category->getID() || (int) $ticket['status'] !== Ticket::ASSIGNED) {
        throw new RuntimeException('A categoria ou o status do chamado não foi preservado.');
    }
    $followups = api('GET', 'Ticket/' . $ticketId . '/ITILFollowup', $userHeaders);
    if (count($followups) !== 1 || (int) $followups[0]['is_private'] !== 0) {
        throw new RuntimeException('O solicitante deve receber somente o acompanhamento público.');
    }
} finally {
    foreach ($sessions as $session) {
        api('GET', 'killSession', ['Session-Token: ' . $session]);
    }
}

echo 'OK: autenticação, criação, categoria Geral, resposta pública, nota privada e mudança de status.' . PHP_EOL;
echo 'Chamado de demonstração mantido: http://127.0.0.1:8088/front/ticket.form.php?id=' . $ticketId . PHP_EOL;
