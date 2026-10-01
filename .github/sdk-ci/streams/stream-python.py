from pathlib import Path
import sys
_fixture_root = next(p for p in [Path(__file__).resolve().parent, Path(__file__).resolve().parent.parent, Path('/sdk/conformance'), Path('/')] if (p/'fixed-origin'/'httpx_fixture.py').exists())
sys.path.insert(0, str(_fixture_root/'fixed-origin'))
from httpx_fixture import route_api, route_http
import asyncio
import os
import httpx
from reacon_sdk import AsyncReacon, ReaconProtocolError, ReaconTimeoutError, ReaconStreamApiError

async def main():
    url = os.environ['REACON_TEST_URL']
    async with route_http(httpx.AsyncClient(), url) as http, route_http(httpx.AsyncClient(), url) as other, AsyncReacon('synthetic-python', http_client=http) as client, AsyncReacon('isolated-python', http_client=other) as isolated:
        client.stream_verification('never@example.test')  # no request until context entry
        async def collect(scenario, owner=client, **options):
            async with owner.stream_verification(f'{scenario}@example.test', only_if_free='true', **options) as stream:
                return [event async for event in stream]
        results = await asyncio.gather(collect('success'), collect('isolated', owner=isolated))
        for values in results:
            assert [event.type for event in values] == ['stage', 'unknown', 'progress', 'final']
            assert values[0].raw['label'] == 'hé🚀' and values[1].raw['future']['value'] == 'hé🚀'
            assert values[3].data.result.accepts_all is None and values[3].data.result.status == 'future-status'
        try: await collect('error')
        except ReaconStreamApiError as error:
            assert error.status == 200 and error.event.code == 'INSUFFICIENT_CREDITS'
            assert error.event.remaining_credits == 0 and error.request_id == 'req-stream'
        else: raise AssertionError('Missing terminal error')
        for scenario, status in [('pre402', 402), ('pre429', 429), ('proxy', 502), ('redirect', 307)]:
            try: await collect(scenario)
            except ReaconStreamApiError as error:
                assert error.status == status
                if status in (402, 429): assert error.body['code'] == 'FIXTURE_ERROR' and error.request_id == 'req-stream'
                if status == 502: assert error.request_id is None and isinstance(error.body, str)
            else: raise AssertionError(f'Missing HTTP error {status}')
        for scenario in ['wrongtype', 'malformed', 'invalidresult', 'eof']:
            try: await collect(scenario)
            except ReaconProtocolError: pass
            else: raise AssertionError(f'Missing protocol error {scenario}')
        try: await collect('disconnect')
        except httpx.RemoteProtocolError: pass
        else: raise AssertionError('Missing dropped connection error')
        for phase in ['idle', 'total']:
            try: await collect(phase, idle_timeout=0.08, total_timeout=0.2)
            except ReaconTimeoutError as error: assert error.phase == phase
            else: raise AssertionError(f'Missing timeout {phase}')
        try: await collect('headers', idle_timeout=0.08, total_timeout=0.2)
        except ReaconTimeoutError: pass
        else: raise AssertionError('Missing header timeout')
        async with client.stream_verification('cancel@example.test', only_if_free='true') as stream:
            assert (await anext(stream)).type == 'stage'
            task = asyncio.create_task(anext(stream))
            await asyncio.sleep(0.02); task.cancel()
            try: await task
            except asyncio.CancelledError: pass
            else: raise AssertionError('Missing cancellation')
        async with client.stream_verification('early@example.test', only_if_free='true') as stream:
            async for event in stream:
                assert event.type == 'stage'
                break
        async with httpx.AsyncClient() as control:
            closed = await control.get(url + '/_assert_closed')
            assert closed.status_code == 200 and closed.json()['closed']
    # Borrowed transports remain usable after the facade closes.
    async with httpx.AsyncClient() as transport:
        facade = AsyncReacon('unused', http_client=transport)
        await facade.aclose()
        assert not transport.is_closed
    print('Python streaming: framing, terminal/error, isolation, timeout, cancellation and early-close assertions passed')

asyncio.run(main())
