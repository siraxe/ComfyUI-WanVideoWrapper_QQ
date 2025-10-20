import os
import json
from aiohttp import web

from server import PromptServer
import folder_paths

from .utils import path_exists
from .utils_server import get_param, is_param_falsy
from .utils_info import delete_model_info, get_model_info, set_model_info_partial, get_file_info

routes = PromptServer.instance.routes


def _check_valid_model_type(request):
  model_type = request.match_info['type']
  if model_type not in ['loras', 'checkpoints']:
    return web.json_response({'status': 404, 'error': f'Invalid model type: {model_type}'})
  return None


@routes.get('/wanvid/api/{type}')
async def api_get_models_list(request):
  """Returns a list of model types from user configuration.

  By default, a list of filenames are provided. If `format=details` is specified, a list of objects
  with additional _file info_ is provided. This includes modigied time, hasInfoFile, and imageLocal
  among others.
  """
  if _check_valid_model_type(request):
    return _check_valid_model_type(request)

  model_type = request.match_info['type']
  files = folder_paths.get_filename_list(model_type)
  format_param = get_param(request, 'format')
  if format_param == 'details':
    response = []
    for file in files:
      response.append(get_file_info(file, model_type))
    return web.json_response(response)

  return web.json_response(list(files))


@routes.get('/wanvid/api/{type}/info')
async def api_get_models_info(request):
  """Returns a list model info; either all or a specific ones if provided a 'files' param.

  If a `light` param is specified and not falsy, no metadata will be fetched.
  """
  if _check_valid_model_type(request):
    return _check_valid_model_type(request)

  model_type = request.match_info['type']
  files_param = get_param(request, 'files')
  maybe_fetch_metadata = files_param is not None
  if not is_param_falsy(request, 'light'):
    maybe_fetch_metadata = False
  api_response = await models_info_response(
    request, model_type, maybe_fetch_metadata=maybe_fetch_metadata
  )
  return web.json_response(api_response)


@routes.get('/wanvid/api/{type}/info/refresh')
async def api_get_refresh_get_models_info(request):
  """Refreshes model info; either all or specific ones if provided a 'files' param. """
  if _check_valid_model_type(request):
    return _check_valid_model_type(request)

  model_type = request.match_info['type']
  api_response = await models_info_response(
    request, model_type, maybe_fetch_civitai=True, maybe_fetch_metadata=True
  )
  return web.json_response(api_response)


@routes.get('/wanvid/api/{type}/info/clear')
async def api_get_delete_model_info(request):
  """Clears model info from the filesystem for specific files only - no bulk clearing."""
  if _check_valid_model_type(request):
    return _check_valid_model_type(request)

  api_response = {'status': 200}
  model_type = request.match_info['type']
  files_param = get_param(request, 'files')

  # Always require files parameter - no bulk clearing
  if not files_param:
    api_response['status'] = '400'
    api_response['error'] = 'Missing required parameter: files'
    return api_response

  files_param = files_param.split(',')
  del_info = not is_param_falsy(request, 'del_info')
  del_metadata = not is_param_falsy(request, 'del_metadata')
  del_civitai = not is_param_falsy(request, 'del_civitai')

  # Validate that files exist
  all_files = folder_paths.get_filename_list(model_type)
  valid_files = []
  for file_param in files_param:
    if file_param in all_files:
      valid_files.append(file_param)
    else:
      print(f"[Warning] File not found for clearing: {file_param}")

  if not valid_files:
    api_response['status'] = '404'
    api_response['error'] = 'No valid files found'
    return api_response

  # Clear info for only the specified files
  for file_param in valid_files:
    await delete_model_info(
      file_param,
      model_type,
      del_info=del_info,
      del_metadata=del_metadata,
      del_civitai=del_civitai
    )
  return web.json_response(api_response)


@routes.post('/wanvid/api/{type}/info')
async def api_post_save_model_data(request):
  """Saves data to a model by name. """
  if _check_valid_model_type(request):
    return _check_valid_model_type(request)

  model_type = request.match_info['type']
  api_response = {'status': 200}
  file_param = get_param(request, 'file')
  if file_param is None:
    api_response['status'] = '404'
    api_response['error'] = 'No model found at path'
  else:
    post = await request.post()
    await set_model_info_partial(file_param, model_type, json.loads(post.get("json")))
    info_data = await get_model_info(file_param, model_type)
    api_response['data'] = info_data
  return web.json_response(api_response)


@routes.get('/wanvid/api/{type}/img')
async def api_get_models_info_img(request):
  """ Returns an image response if one exists for the model. """
  if _check_valid_model_type(request):
    return _check_valid_model_type(request)

  model_type = request.match_info['type']
  file_param = get_param(request, 'file')
  file_path = folder_paths.get_full_path(model_type, file_param)
  if not path_exists(file_path):
    file_path = os.path.abspath(file_path)

  img_path = None
  for ext in ['jpg', 'png', 'jpeg']:
    try_path = f'{os.path.splitext(file_path)[0]}.{ext}'
    if path_exists(try_path):
      img_path = try_path
      break

  if not path_exists(img_path):
    api_response = {}
    api_response['status'] = '404'
    api_response['error'] = 'No model found at path'
    return web.json_response(api_response)

  return web.FileResponse(img_path)


@routes.get('/wanvid/api/loras/preview')
async def api_get_lora_preview_image(request):
  """Returns a preview image from the _power_preview directory."""
  api_response = {'status': 200}

  try:
    # Get parameters
    file_param = get_param(request, 'file')
    subfolder_param = get_param(request, 'subfolder', '')
    suffix_param = get_param(request, 'suffix', '')  # Optional suffix parameter

    if not file_param:
      api_response['status'] = '400'
      api_response['error'] = 'Missing required parameter: file'
      return web.json_response(api_response)

    # Security: prevent directory traversal
    if '..' in file_param or '..' in subfolder_param:
      api_response['status'] = '400'
      api_response['error'] = 'Invalid file path'
      return web.json_response(api_response)

    # Get loras directory
    loras_dir = folder_paths.get_folder_paths('loras')[0]

    # Create _power_preview directory structure (same as save function)
    power_preview_dir = os.path.join(loras_dir, '_power_preview')

    # Construct the full path
    if subfolder_param:
      # Remove leading/trailing slashes from subfolder
      subfolder_param = subfolder_param.strip('/\\')
      search_dir = os.path.join(power_preview_dir, subfolder_param)
    else:
      search_dir = power_preview_dir

    # Try different image extensions
    img_path = None

    # If suffix is specified, look for that specific file
    if suffix_param:
      for ext in ['jpg', 'jpeg', 'png']:
        try_path = os.path.join(search_dir, f"{file_param}{suffix_param}.{ext}")
        if path_exists(try_path):
          img_path = try_path
          break
    else:
      # Try suffixed images first (_01.jpg, _02.jpg, _03.jpg)
      for i in range(1, 4):  # Check for _01, _02, _03
        suffix = f"_{i:02d}"
        for ext in ['jpg', 'jpeg', 'png']:
          try_path = os.path.join(search_dir, f"{file_param}{suffix}.{ext}")
          if path_exists(try_path):
            img_path = try_path
            break
        if img_path:
          break

      # If no suffixed images found, try original image (backward compatibility)
      if not img_path:
        for ext in ['jpg', 'jpeg', 'png']:
          try_path = os.path.join(search_dir, f"{file_param}.{ext}")
          if path_exists(try_path):
            img_path = try_path
            break

    if not img_path:
      api_response['status'] = '404'
      api_response['error'] = 'Preview image not found'
      return web.json_response(api_response)

    # Security: ensure the file is within the power_preview directory
    if not os.path.abspath(img_path).startswith(os.path.abspath(power_preview_dir)):
      api_response['status'] = '403'
      api_response['error'] = 'Access denied'
      return web.json_response(api_response)

    return web.FileResponse(img_path)

  except Exception as e:
    api_response['status'] = '500'
    api_response['error'] = f'Server error: {str(e)}'
    return web.json_response(api_response)


@routes.get('/wanvid/api/loras/previews')
async def api_get_lora_previews_list(request):
  """Returns a list of LoRAs that have preview images available."""
  api_response = {'status': 200, 'previews': []}

  try:
    # Get loras directory
    loras_dir = folder_paths.get_folder_paths('loras')[0]
    power_preview_dir = os.path.join(loras_dir, '_power_preview')

    if not path_exists(power_preview_dir):
      return web.json_response(api_response)

    # Get all LoRA files
    lora_files = folder_paths.get_filename_list('loras')

    # Check each LoRA for preview images
    for lora_file in lora_files:
      lora_name = lora_file
      # Remove extension
      for ext in ['.safetensors', '.pt', '.ckpt']:
        if lora_name.endswith(ext):
          lora_name = lora_name[:-len(ext)]
          break

      # Check for preview in various locations
      preview_found = False
      preview_paths = []

      # Check for suffixed preview images first (_01.jpg, _02.jpg, _03.jpg)
      found_suffixes = []
      for i in range(1, 4):  # Check for _01, _02, _03
        suffix = f"_{i:02d}"

        # Check root _power_preview directory
        for img_ext in ['jpg', 'jpeg', 'png']:
          preview_path = os.path.join(power_preview_dir, f"{lora_name}{suffix}.{img_ext}")
          if path_exists(preview_path):
            preview_found = True
            preview_paths.append(f"_power_preview/{lora_name}{suffix}.{img_ext}")
            found_suffixes.append(suffix)
            break

        # Check subfolders
        path_parts = lora_name.replace('/', os.sep).replace('\\', os.sep).split(os.sep)
        if len(path_parts) > 1:
          subfolder = os.sep.join(path_parts[:-1])
          filename = path_parts[-1]

          subfolder_path = os.path.join(power_preview_dir, subfolder)
          if path_exists(subfolder_path):
            for img_ext in ['jpg', 'jpeg', 'png']:
              preview_path = os.path.join(subfolder_path, f"{filename}{suffix}.{img_ext}")
              if path_exists(preview_path):
                preview_found = True
                preview_paths.append(f"_power_preview/{subfolder}/{filename}{suffix}.{img_ext}")
                found_suffixes.append(suffix)
                break

      # If no suffixed images found, check for single image (backward compatibility)
      if not found_suffixes:
        # Check root _power_preview directory
        for img_ext in ['jpg', 'jpeg', 'png']:
          preview_path = os.path.join(power_preview_dir, f"{lora_name}.{img_ext}")
          if path_exists(preview_path):
            preview_found = True
            preview_paths.append(f"_power_preview/{lora_name}.{img_ext}")
            break

        # Check subfolders if not found in root
        if not preview_found:
          # Look for subfolder structure
          path_parts = lora_name.replace('/', os.sep).replace('\\', os.sep).split(os.sep)
          if len(path_parts) > 1:
            subfolder = os.sep.join(path_parts[:-1])
            filename = path_parts[-1]

            subfolder_path = os.path.join(power_preview_dir, subfolder)
            if path_exists(subfolder_path):
              for img_ext in ['jpg', 'jpeg', 'png']:
                preview_path = os.path.join(subfolder_path, f"{filename}.{img_ext}")
                if path_exists(preview_path):
                  preview_found = True
                  preview_paths.append(f"_power_preview/{subfolder}/{filename}.{img_ext}")
                  break

      if preview_found:
        api_response['previews'].append({
          'lora': lora_file,
          'preview_paths': preview_paths
        })

    return web.json_response(api_response)

  except Exception as e:
    api_response['status'] = '500'
    api_response['error'] = f'Server error: {str(e)}'
    return web.json_response(api_response)


@routes.post('/wanvid/api/lora/preview-image')
async def api_save_lora_preview_image(request):
  """Save a preview image for a LoRA in the _power_preview directory."""
  import io
  from PIL import Image

  api_response = {'status': 200, 'message': 'Preview image saved successfully'}

  try:
    # Get form data
    post = await request.post()
    image_file = post.get('image')
    lora_name = post.get('lora_name')
    lora_path = post.get('lora_path', '')
    suffix = post.get('suffix', '')

    if not image_file or not lora_name:
      api_response['status'] = '400'
      api_response['error'] = 'Missing required parameters: image and lora_name'
      return web.json_response(api_response)

    # Get loras directory
    loras_dir = folder_paths.get_folder_paths('loras')[0]

    # Create _power_preview directory structure
    power_preview_dir = os.path.join(loras_dir, '_power_preview')
    if lora_path:
      save_dir = os.path.join(power_preview_dir, lora_path)
    else:
      save_dir = power_preview_dir

    # Ensure directory exists
    os.makedirs(save_dir, exist_ok=True)

    # Construct save path with optional suffix
    filename = f"{lora_name}{suffix}.jpg"
    save_path = os.path.join(save_dir, filename)

    # Read image data
    image_data = image_file.file.read()

    # Open with PIL, process, and save
    with Image.open(io.BytesIO(image_data)) as img:
      # Convert to RGB if necessary (for JPEG)
      if img.mode in ('RGBA', 'LA', 'P'):
        # Create white background for transparency
        background = Image.new('RGB', img.size, (255, 255, 255))
        if img.mode == 'P':
          img = img.convert('RGBA')
        if img.mode in ('RGBA', 'LA'):
          background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
          img = background
        else:
          img = img.convert('RGB')
      elif img.mode != 'RGB':
        img = img.convert('RGB')

      # Save as JPEG with high quality
      img.save(save_path, 'JPEG', quality=90, optimize=True)

    api_response['save_path'] = os.path.relpath(save_path, loras_dir)
    api_response['file_size'] = os.path.getsize(save_path)
    api_response['filename'] = filename

  except Exception as e:
    api_response['status'] = '500'
    api_response['error'] = f'Failed to save preview image: {str(e)}'
    print(f"[Preview Image Error] {str(e)}")

  return web.json_response(api_response)


async def models_info_response(
  request, model_type, maybe_fetch_civitai=False, maybe_fetch_metadata=False
):
  """Gets model info for specific files only - no bulk processing allowed."""
  api_response = {'status': 200, 'data': []}
  light = not is_param_falsy(request, 'light')
  files_param = get_param(request, 'files')

  # Always require files parameter - no bulk processing
  if not files_param:
    api_response['status'] = '400'
    api_response['error'] = 'Missing required parameter: files'
    return api_response

  files_param = files_param.split(',')

  # Validate that files exist
  all_files = folder_paths.get_filename_list(model_type)
  valid_files = []
  for file_param in files_param:
    if file_param in all_files:
      valid_files.append(file_param)
    else:
      print(f"[Warning] File not found: {file_param}")

  if not valid_files:
    api_response['status'] = '404'
    api_response['error'] = 'No valid files found'
    return api_response

  # Process only the specified files
  for file_param in valid_files:
    info_data = await get_model_info(
      file_param,
      model_type,
      maybe_fetch_civitai=maybe_fetch_civitai,
      maybe_fetch_metadata=maybe_fetch_metadata,
      light=light
    )
    api_response['data'].append(info_data)
  return api_response
