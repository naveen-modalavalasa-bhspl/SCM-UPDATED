// @ts-nocheck
import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Button, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, Row, Col, Table, Card, Descriptions, Divider, Typography, Tag, Badge, App, Spin, Tooltip
} from 'antd';
import {
  ArrowLeftOutlined, PlusOutlined, EditOutlined, DeleteOutlined,
  CheckOutlined, MinusCircleOutlined, InboxOutlined, SaveOutlined,
  SendOutlined, FileDoneOutlined, BarcodeOutlined, QrcodeOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../components/PageHeader';
import StatusTag from '../components/StatusTag';
import ItemSelector from '../components/ItemSelector';
import SerialNumbersModal from '../components/SerialNumbersModal';
import AssetCodesTreeModal from '../components/AssetCodesTreeModal';
import api from '../config/api';
import useAuthStore from '../store/authStore';
import {
  formatDate, formatCurrency, formatNumber, getErrorMessage,
  formatDateForAPI,
} from '../utils/helpers';
import { DATE_FORMAT } from '../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const MaterialIssueForm = ({ templateType, title: propTitle }) => {
  const { message } = App.useApp();
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isNew = !id || id === 'new';
  const user = useAuthStore((s) => s.user);
  const backPath = templateType 
    ? `/warehouse/material-issues/ap104-${templateType}`
    : '/warehouse/material-issues';

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [recordData, setRecordData] = useState(null);
  const [editMode, setEditMode] = useState(isNew);

  // Form states
  const [issueItems, setIssueItems] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [allWarehouses, setAllWarehouses] = useState([]);
  const [indentOptions, setIndentOptions] = useState([]);

  const [uomOptions, setUomOptions] = useState([]);
  const [userOptions, setUserOptions] = useState([]);
  const [projects, setProjects] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);

  // item_id -> available qty (in the currently-selected warehouse). Populated
  // when an indent is picked or when the warehouse changes; surfaces inline so
  // the store keeper sees how much they can actually issue per line.
  const [stockMap, setStockMap] = useState({});
  // item_id -> valuation_rate from stock balance (used to auto-fill rate column)
  const [rateMap, setRateMap] = useState({});
  // item_id -> { batches: [{id, batch_number, expiry_date, rate}], bins: [{id, code}] }
  // Populated when an item is selected to allow batch/bin dropdown selection
  const [itemStockDetails, setItemStockDetails] = useState({});
  // Whether the source warehouse is a central warehouse (determines batch/bin UX)
  const [isCentralWarehouse, setIsCentralWarehouse] = useState(true);

  // --- Tree Modal State for Asset/Consumable Codes ---
  const [treeModalOpen, setTreeModalOpen] = useState(false);
  const [activeRowKey, setActiveRowKey] = useState(null);
  const activeTreeRow = issueItems.find((item) => item.key === activeRowKey);

  // --- Item Row Helpers ---
  const createEmptyItem = () => ({
    key: Date.now() + Math.random(),
    item_id: null,
    item_name: '',
    item_code: '',
    item_type: '',
    uom_id: null,
    qty: 0,
    batch_id: null,
    bin_id: null,
    rate: 0,
    amount: 0,
    has_batch: false,
    has_serial: false,
    serial_numbers: [],
    batch_number_text: '',  // non-central WH traceability
    bin_code_text: '',      // non-central WH traceability
  });

  const recalcItem = (item) => {
    item.amount = Number(((item.qty || 0) * (item.rate || 0)).toFixed(2));
    return item;
  };

  const updateIssueItem = (key, field, value) => {
    setIssueItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        const updated = { ...item, [field]: value };
        return recalcItem(updated);
      })
    );
  };

  const updateIssueItemFields = (key, fieldsObj) => {
    setIssueItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        const updated = { ...item, ...fieldsObj };
        return recalcItem(updated);
      })
    );
  };

  const addItemRow = () => {
    setIssueItems((prev) => [...prev, createEmptyItem()]);
  };

  const removeItemRow = (key) => {
    setIssueItems((prev) => prev.filter((i) => i.key !== key));
  };

  const calcTotalQty = () => issueItems.reduce((s, i) => s + (i.qty || 0), 0);
  const calcTotalAmount = () => issueItems.reduce((s, i) => s + (i.amount || 0), 0);

  // --- Lookups ---
  const loadLookups = useCallback(async () => {
    try {
      const [whRes, allWhRes, uomRes, userRes] = await Promise.allSettled([
        api.get('/masters/warehouses', { params: { page_size: 200, exclude_virtual: true } }),
        api.get('/masters/warehouses', { params: { page_size: 200 } }),
        api.get('/masters/uom', { params: { page_size: 200 } }),
        api.get('/users/lookup', { params: { page_size: 200 } }),
      ]);
      if (whRes.status === 'fulfilled') {
        const w = whRes.value.data;
        setWarehouses(
          (w.items || w.data || w || []).map((i) => ({
            label: i.name || i.warehouse_name,
            value: i.id,
          }))
        );
      }
      if (allWhRes.status === 'fulfilled') {
        const w = allWhRes.value.data;
        setAllWarehouses(
          (w.items || w.data || w || []).map((i) => ({
            label: i.name || i.warehouse_name,
            value: i.id,
          }))
        );
      }
      if (uomRes.status === 'fulfilled') {
        const u = uomRes.value.data;
        setUomOptions(
          (u.items || u.data || u || []).map((i) => ({
            label: i.name || i.uom_name || i.code,
            value: i.id,
          }))
        );
      }
      if (userRes.status === 'fulfilled') {
        const u = userRes.value.data;
        setUserOptions(
          (u.items || u.data || u || []).map((i) => ({
            label: i.full_name || i.name || i.username || i.email,
            value: i.id,
          }))
        );
      }
    } catch (err) {
      console.error('Error loading lookups:', err);
    }
  }, []);

  const loadIndentOptions = useCallback(async (search = '') => {
    try {
      const params = { page_size: 50, search, available_for_issue: true };
      const res = await api.get('/indent/indents', { params });
      const data = res.data;
      const items = data.items || data.data || data || [];
      const newOptions = items.map((ind) => ({
        label: `${ind.indent_number}${ind.warehouse_name ? ` · ${ind.warehouse_name}` : ''}${ind.raised_by_name ? ` · ${ind.raised_by_name}` : ''}`,
        value: ind.id,
      }));

      const currentVal = form.getFieldValue('indent_id');
      if (currentVal) {
        setIndentOptions((prev) => {
          const selectedOpt = prev.find((o) => o.value === currentVal);
          if (selectedOpt && !newOptions.some((o) => o.value === currentVal)) {
            return [selectedOpt, ...newOptions];
          }
          return newOptions;
        });
      } else {
        setIndentOptions(newOptions);
      }
    } catch (err) {
      console.error('Error loading indent options:', err);
    }
  }, [form]);



  const refreshStockForItems = useCallback(async (warehouseId, itemIds) => {
    if (!warehouseId || !itemIds || itemIds.length === 0) {
      setStockMap({});
      setRateMap({});
      return;
    }
    try {
      const res = await api.get('/inventory/stock-balance', {
        params: {
          warehouse_id: warehouseId,
          item_id: itemIds.join(','),
          page_size: 200,
        },
      });
      const rows = res.data?.items || res.data?.data || res.data || [];
      if (!Array.isArray(rows)) {
        return;
      }
      const map = {};
      const rates = {};
      itemIds.forEach((id) => {
        map[id] = 0;
      });
      rows.forEach((r) => {
        const k = r.item_id;
        const key = k || r.item_code;
        if (key) {
          map[key] = (map[key] || 0) + (Number(r.available_qty) || 0);
          if (!rates[key] && Number(r.valuation_rate) > 0) {
            rates[key] = Number(r.valuation_rate);
          }
        }
      });
      setStockMap((prev) => ({ ...prev, ...map }));
      setRateMap((prev) => ({ ...prev, ...rates }));
    } catch (err) {
      console.error('refreshStockForItems error:', err);
    }
  }, []);

  const fetchItemStockDetails = useCallback(async (warehouseId, itemId) => {
    if (!warehouseId || !itemId) return;
    try {
      const res = await api.get(`/inventory/stock-balance/${itemId}/breakdown`);
      const allRows = res.data?.items || res.data?.data || res.data || [];
      if (!Array.isArray(allRows)) return;
      const rows = allRows.filter(r => Number(r.warehouse_id) === Number(warehouseId));
      if (!Array.isArray(rows)) return;

      const batchMap = new Map();
      const binMap = new Map();

      rows.forEach((r) => {
        const bid = r.batch_id;
        const bName = r.batch_number || r.batch_name || (bid ? `Batch ${bid}` : 'No Batch');
        const bidKey = bid === null ? 'null_batch' : bid;
        if (!batchMap.has(bidKey)) {
          batchMap.set(bidKey, {
            id: bid,
            batch_number: bName,
            expiry_date: r.expiry_date,
            qty: Number(r.available_qty) || 0,
            rate: Number(r.valuation_rate) || 0,
          });
        } else {
          batchMap.get(bidKey).qty += Number(r.available_qty) || 0;
          const existingRate = batchMap.get(bidKey).rate || 0;
          const newRate = Number(r.valuation_rate) || 0;
          if (newRate > 0 && existingRate === 0) {
            batchMap.get(bidKey).rate = newRate;
          }
        }

        const bnid = r.bin_id;
        const bCode = r.bin_code || r.bin_name || (bnid ? `Bin ${bnid}` : 'General Area');
        const bnidKey = bnid === null ? 'null_bin' : bnid;
        if (!binMap.has(bnidKey)) {
          binMap.set(bnidKey, {
            id: bnid,
            code: bCode,
            qty: Number(r.available_qty) || 0,
          });
        } else {
          binMap.get(bnidKey).qty += Number(r.available_qty) || 0;
        }
      });

      const batches = Array.from(batchMap.values());
      const bins = Array.from(binMap.values());

      const serialsMap = {};
      let itemHasSerial = false;
      rows.forEach((r) => {
        if (r.has_serial) {
          itemHasSerial = true;
        }
        const key = `${r.batch_id || 'null'}-${r.bin_id || 'null'}`;
        if (Array.isArray(r.serial_numbers)) {
          serialsMap[key] = r.serial_numbers;
        }
      });

      setItemStockDetails((prev) => ({
        ...prev,
        [itemId]: { batches, bins, serialsMap, hasSerial: itemHasSerial, rawRows: rows },
      }));

      if (itemHasSerial) {
        setIssueItems((prev) =>
          prev.map((it) => (it.item_id === itemId ? { ...it, has_serial: true } : it))
        );
      }

      // Auto-select if there is only one option to save user clicks
      const currentItems = form.getFieldValue('items') || [];
      const hasUpdates = currentItems.some(it =>
        it.item_id === itemId &&
        ((batches.length === 1 && !it.batch_id) || (bins.length === 1 && !it.bin_id))
      );

      if (hasUpdates) {
        const newData = currentItems.map((it) => {
          if (it.item_id === itemId) {
            return {
              ...it,
              batch_id: (batches.length === 1 && !it.batch_id) ? batches[0].id : it.batch_id,
              bin_id: (bins.length === 1 && !it.bin_id) ? bins[0].id : it.bin_id,
            };
          }
          return it;
        });
        form.setFieldsValue({ items: newData });
      }
    } catch (err) {
      console.error('Failed to fetch stock details:', err);
    }
  }, [form]);

  const prefillFromIndent = useCallback(async (indentId) => {
    if (!indentId) {
      setStockMap({});
      form.setFieldsValue({
        destination_warehouse_id: undefined,
        issued_to: undefined,
      });
      return;
    }
    try {
      const res = await api.get(`/indent/indents/${indentId}`);
      const ind = res.data;
      if (!ind) return;

      const optionLabel = `${ind.indent_number}${ind.warehouse_name ? ` · ${ind.warehouse_name}` : ''}${ind.raised_by_name ? ` · ${ind.raised_by_name}` : ''}`;
      const newOption = { label: optionLabel, value: ind.id };
      setIndentOptions((prev) => {
        if (prev.some((opt) => opt.value === ind.id)) return prev;
        return [newOption, ...prev];
      });

      let sourceWarehouseId = null;
      try {
        const whRes = await api.get('/masters/warehouses', { params: { page_size: 200 } });
        const whList = Array.isArray(whRes.data) ? whRes.data : (whRes.data?.items || []);
        
        const userRole = (user?.user_type || '').toLowerCase();
        const isAdmin = ['admin', 'superadmin', 'super_admin', 'manager'].includes(userRole);
        
        if (isAdmin) {
          // Look for central warehouse: parent_id is null/undefined or name/code contains central
          const centralWh = whList.find(w => 
            w.parent_id === null || 
            w.parent_id === undefined || 
            (w.code || '').toUpperCase().includes('CENTRAL') || 
            (w.name || '').toUpperCase().includes('CENTRAL')
          );
          if (centralWh) {
            sourceWarehouseId = centralWh.id;
          }
        }
        
        // If not admin, or central warehouse not found, default to user's assigned warehouse
        if (!sourceWarehouseId && user?.warehouse_id) {
          sourceWarehouseId = Number(user.warehouse_id);
        }
        
        // If still not resolved, fall back to indent's warehouse
        if (!sourceWarehouseId) {
          sourceWarehouseId = ind.warehouse_id;
          const indentWh = whList.find((w) => w.id === ind.warehouse_id);
          const isVirtual = indentWh && indentWh.type === 'virtual';
          if (isVirtual) {
            const realWh = whList.find((w) => w.type === 'main' || w.type === 'regional');
            if (realWh) sourceWarehouseId = realWh.id;
          }
        }
      } catch {
        sourceWarehouseId = ind.warehouse_id;
      }

      form.setFieldsValue({
        warehouse_id: sourceWarehouseId,
        destination_warehouse_id: ind.warehouse_id,
        department: ind.department || form.getFieldValue('department'),
        issued_to: ind.raised_by || form.getFieldValue('issued_to'),
        vehicle_code: ind.vehicle_code || undefined,
        vehicle_number: ind.vehicle_number || undefined,
        service_code: ind.service_code || undefined,
      });

      const lines = (ind.items || [])
        .map((it) => ({
          key: `${it.id}-${Date.now()}-${Math.random()}`,
          item_id: it.item_id,
          item_name: it.item_name || it.name || '',
          item_code: it.item_code || '',
          item_type: it.item_type || '',
          uom_id: it.uom_id || null,
          qty: Math.max(
            Number(
              it.issue_remaining_qty ?? (
                (Number(it.approved_qty ?? it.requested_qty) || 0)
                - (Number(it.issued_qty) || 0)
              ),
            ) || 0,
            0,
          ),
          batch_id: null,
          bin_id: null,
          rate: Number(it.rate) || Number(it.purchase_price) || 0,
          amount: 0,
          has_batch: !!it.has_batch,
          has_serial: !!it.has_serial,
          serial_numbers: [],
        }))
        // Exclude lines already fully issued — nothing left to issue for them
        .filter((line) => line.qty > 0);

      setIssueItems(lines.length > 0 ? lines : [createEmptyItem()]);
      const itemIds = lines.map((l) => l.item_id).filter(Boolean);
      await refreshStockForItems(sourceWarehouseId, itemIds);
      itemIds.forEach((id) => fetchItemStockDetails(sourceWarehouseId, id));
      message.success(`Loaded ${lines.length} line${lines.length === 1 ? '' : 's'} from ${ind.indent_number}`);
    } catch (err) {
      message.error(getErrorMessage(err) || 'Could not load indent');
    }
  }, [form, refreshStockForItems, fetchItemStockDetails, message]);

  const loadProjects = useCallback(async () => {
    try {
      const projRes = await api.get('/masters/projects', { params: { page_size: 200 } });
      const data = projRes.data?.items || projRes.data?.data || projRes.data || [];
      setProjects(data.map((p) => ({ label: p.name || p.project_name, value: p.id })));
    } catch { /* silent */ }
  }, []);

  const prefillFromTemplate = useCallback(async (projectId, tempType) => {
    if (!projectId) {
      setIssueItems([createEmptyItem()]);
      return;
    }
    setLoading(true);
    try {
      const res = await api.get('/masters/project-indent-templates', {
        params: { project_id: projectId, template_type: tempType }
      });
      const data = res.data;
      if (data && data.items && data.items.length > 0) {
        const lines = data.items.map((it) => ({
          key: `${it.id}-${Date.now()}-${Math.random()}`,
          item_id: it.item_id,
          item_name: it.item_name || '',
          item_code: it.item_code || '',
          item_type: it.item_type || '',
          qty: Number(it.quantity) || 0,
          uom_id: it.uom_id || null,
          batch_id: null,
          bin_id: null,
          rate: 0,
          amount: 0,
          has_batch: !!it.has_batch,
          has_serial: !!it.has_serial,
          serial_numbers: [],
          batch_number_text: '',
          bin_code_text: '',
        }));
        setIssueItems(lines);
        const sourceWarehouseId = form.getFieldValue('warehouse_id');
        if (sourceWarehouseId) {
          const itemIds = lines.map((l) => l.item_id).filter(Boolean);
          await refreshStockForItems(sourceWarehouseId, itemIds);
          itemIds.forEach((id) => fetchItemStockDetails(sourceWarehouseId, id));
        }
        message.success(`Loaded ${lines.length} items from template`);
      } else {
        setIssueItems([createEmptyItem()]);
        message.warning(`No template configured for this project under type '${tempType}'`);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [form, refreshStockForItems, fetchItemStockDetails, message]);

  const loadVehicleOptions = useCallback(async (search = '') => {
    setVehiclesLoading(true);
    try {
      const res = await api.get('/masters/vehicles', {
        params: { is_active: true, search, limit: 100 },
      });
      const data = res.data || [];
      
      const currentVal = form.getFieldValue('vehicle_code');
      if (currentVal) {
        setVehicles((prev) => {
          const matched = prev.find((v) => v.vehicle_code === currentVal);
          if (matched && !data.some((v) => v.vehicle_code === currentVal)) {
            return [matched, ...data];
          }
          return data;
        });
      } else {
        setVehicles(data);
      }
    } catch (err) {
      console.error('Error loading vehicles:', err);
    } finally {
      setVehiclesLoading(false);
    }
  }, [form]);

  const handleVehicleChange = (val) => {
    const matched = vehicles.find((v) => v.vehicle_code === val);
    if (matched) {
      form.setFieldsValue({ vehicle_number: matched.vehicle_number });
    } else {
      form.setFieldsValue({ vehicle_number: '' });
    }
  };

  // --- Fetch existing record ---
  const fetchRecord = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/warehouse/material-issues/${id}`);
      const data = res.data;
      setRecordData(data);
      form.setFieldsValue({
        warehouse_id: data.warehouse_id,
        destination_warehouse_id: data.destination_warehouse_id,
        indent_id: data.indent_id,
        department: data.department,
        issued_to: data.issued_to,
        issue_date: data.issue_date ? dayjs(data.issue_date) : null,
        remarks: data.remarks,
        vehicle_code: data.vehicle_code || undefined,
        vehicle_number: data.vehicle_number || undefined,
        service_code: data.service_code || undefined,
        project_id: data.project_id || undefined,
        template_type: data.template_type || undefined,
      });

      if (data.vehicle_code) {
        loadVehicleOptions(data.vehicle_code);
      }

      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_name: item.item_name || '',
        item_code: item.item_code || '',
        item_type: item.item_type || '',
        uom_id: item.uom_id,
        qty: Number(item.qty || 0),
        batch_id: item.batch_id || null,
        // Capture the batch_number from API for display when breakdown returns null IDs (non-central wh)
        batch_number: item.batch_number || null,
        // Populate arrays so the multi-select shows the saved value immediately
        batch_ids: item.batch_id ? [item.batch_id] : [],
        bin_id: item.bin_id || null,
        bin_ids: item.bin_id ? [item.bin_id] : [],
        rate: Number(item.rate || 0),
        amount: Number(item.amount || 0),
        has_batch: !!item.has_batch,
        has_serial: !!item.has_serial,
        serial_numbers: item.serial_numbers || [],
        batch_number_text: item.batch_number_text || '',
        bin_code_text: item.bin_code_text || '',
      }));

      setIssueItems(items.length > 0 ? items : [createEmptyItem()]);

      const warehouseId = data.warehouse_id;
      if (warehouseId) {
        // Detect whether source warehouse is central to control batch/bin UI
        try {
          const whRes = await api.get(`/masters/warehouses/${warehouseId}`);
          const whData = whRes.data;
          setIsCentralWarehouse(
            !!(whData?.is_central ?? (whData?.parent_id === null || whData?.parent_id === undefined))
          );
        } catch {
          setIsCentralWarehouse(true); // safe default: show full dropdowns
        }

        const itemIds = items.map((it) => it.item_id).filter(Boolean);
        await refreshStockForItems(warehouseId, itemIds);
        // Fetch stock details for each item, then restore saved batch/bin selections
        // (fetchItemStockDetails is async and must not overwrite what we loaded)
        await Promise.all(
          items
            .filter((it) => it.item_id)
            .map(async (it) => {
              await fetchItemStockDetails(warehouseId, it.item_id);
              // Re-apply the saved batch/bin after stock details are loaded
              if (it.batch_id || it.bin_id) {
                setIssueItems((prev) =>
                  prev.map((row) => {
                    if (row.key !== it.key) return row;
                    return {
                      ...row,
                      batch_id: it.batch_id,
                      batch_number: it.batch_number,
                      batch_ids: it.batch_id ? [it.batch_id] : row.batch_ids || [],
                      bin_id: it.bin_id,
                      bin_ids: it.bin_id ? [it.bin_id] : row.bin_ids || [],
                    };
                  })
                );
              }
            })
        );
      }

      const queryParams = new URLSearchParams(location.search);
      if (queryParams.get('edit') === 'true' && data.status === 'draft') {
        setEditMode(true);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate(backPath);
    } finally {
      setLoading(false);
    }
  }, [id, form, location.search, navigate, refreshStockForItems, fetchItemStockDetails, message, loadVehicleOptions]);

  // Init
  useEffect(() => {
    loadLookups();
    loadIndentOptions();
    loadVehicleOptions();
    if (!isNew) {
      fetchRecord();
    } else {
      form.setFieldsValue({
        issue_date: dayjs(),
      });
      setIssueItems([createEmptyItem()]);
      const queryParams = new URLSearchParams(location.search);
      const indentId = queryParams.get('indent_id');
      if (indentId) {
        form.setFieldsValue({ indent_id: Number(indentId) });
        prefillFromIndent(Number(indentId));
      }
    }
  }, [id, isNew, fetchRecord, loadLookups, loadIndentOptions, form, location.search, prefillFromIndent, loadVehicleOptions]);

  useEffect(() => {
    if (templateType) {
      loadProjects();
    }
  }, [templateType, loadProjects]);

  useEffect(() => {
    if (!isNew || warehouses.length === 0) return;
    if (form.getFieldValue('warehouse_id') || form.getFieldValue('indent_id') || form.getFieldValue('project_id')) return;

    const queryParams = new URLSearchParams(location.search);
    if (queryParams.get('indent_id')) return;

    const userRole = (user?.user_type || '').toLowerCase();
    const isAdmin = ['admin', 'superadmin', 'super_admin', 'manager'].includes(userRole);
    
    let defaultWarehouseId = null;
    if (isAdmin) {
      const centralOption = warehouses.find(w => 
        (w.label || '').toUpperCase().includes('CENTRAL') || 
        (w.label || '').toUpperCase().includes('HQ') ||
        (w.label || '').toUpperCase().includes('HEAD')
      );
      if (centralOption) {
        defaultWarehouseId = centralOption.value;
      }
    }
    
    if (!defaultWarehouseId && user?.warehouse_id) {
      const assignedWarehouseId = Number(user?.warehouse_id);
      const assignedWarehouseOption = warehouses.find(
        (warehouse) => Number(warehouse.value) === assignedWarehouseId
      );
      if (assignedWarehouseOption) {
        defaultWarehouseId = assignedWarehouseOption.value;
      }
    }
    
    if (!defaultWarehouseId) {
      defaultWarehouseId = warehouses.length === 1 ? warehouses[0].value : null;
    }

    if (!defaultWarehouseId) return;

    form.setFieldsValue({ warehouse_id: defaultWarehouseId });
    loadIndentOptions();
  }, [form, isNew, loadIndentOptions, location.search, user?.warehouse_id, warehouses]);

  // --- Actions ---
  const handleIssue = async () => {
    try {
      const items = recordData?.items || [];
      const invalidItems = items.filter(
        (i) => (i.has_serial || i.item_type === 'asset' || i.item_type === 'consumable') &&
               (!i.serial_numbers || i.serial_numbers.length !== Math.round(Number(i.qty)))
      );
      if (invalidItems.length > 0) {
        message.error('For asset, consumable, or serial-tracked items, selected codes count must equal the quantity. Please edit the issue to select codes.');
        return;
      }
      await api.post(`/warehouse/material-issues/${id}/issue`);
      message.success('Material issued successfully, stock reserved');
      fetchRecord();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleAcknowledge = async () => {
    try {
      await api.post(`/warehouse/material-issues/${id}/acknowledge`);
      message.success('Material issue acknowledged');
      fetchRecord();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleDelete = async () => {
    try {
      await api.delete(`/warehouse/material-issues/${id}`);
      message.success('Material Issue deleted');
      navigate(backPath);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handlePrintAllIssueQRs = () => {
    if (!recordData || !recordData.items) return;
    const printWindow = window.open('', '_blank');
    
    let labelsHTML = '';
    recordData.items.forEach(item => {
      const serials = item.serial_numbers || [];
      if (serials.length === 0) return;
      
      const matCode = item.item_code || '';
      const name = item.item_name || '';
      const batch = item.batch_number || item.batch_name || '-';
      const wh = recordData.warehouse_name || '-';
      const exp = item.expiry_date ? dayjs(item.expiry_date).format('YYYY-MM-DD') : '-';
      
      serials.forEach(code => {
        const payload = `Material: ${matCode}\nItem: ${name}\nBatch: ${batch}\nCode: ${code}\nWarehouse: ${wh}\nExpiry: ${exp}`;
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(payload)}`;
        labelsHTML += `
          <div class="label-card">
            <!-- Top: Code -->
            <div class="label-code">${code} <span style="font-size: 10px; font-weight: normal; color: #475569;">(${matCode})</span></div>
            
            <!-- Middle: QR or Barcode -->
            <div class="qr-container">
              <img class="label-qr" src="${qrUrl}" alt="QR" />
            </div>
            
            <div class="barcode-container" style="display: none; padding: 10px 0;">
              <svg class="barcode-svg" data-code="${code}"></svg>
            </div>
            
            <!-- Bottom: Name -->
            <div class="label-title" style="white-space: normal; height: auto; max-height: 40px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;">${name}</div>
            
            <div class="label-footer">
              <div>Batch: ${batch}</div>
              <div>Loc: ${wh}</div>
            </div>
          </div>
        `;
      });
    });

    if (!labelsHTML) {
      message.warning("No serial or asset/consumable codes found to print");
      return;
    }

    printWindow.document.write(`
      <html>
        <head>
          <title>Print QR/Barcode Labels - ${recordData.issue_number}</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              margin: 20px;
              background: #ffffff;
              color: #000000;
            }
            .no-print {
              margin-bottom: 20px;
              display: flex;
              align-items: center;
              gap: 15px;
              background: #f8fafc;
              padding: 12px 16px;
              border-radius: 8px;
              border: 1px solid #e2e8f0;
            }
            .grid-container {
              display: grid;
              grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
              gap: 15px;
            }
            .label-card {
              border: 1px dashed #cccccc;
              padding: 12px;
              text-align: center;
              border-radius: 8px;
              page-break-inside: avoid;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: space-between;
              height: 240px;
              box-sizing: border-box;
            }
            .label-title {
              font-size: 11px;
              font-weight: bold;
              color: #475569;
              text-transform: uppercase;
              width: 100%;
              overflow: hidden;
              text-overflow: ellipsis;
            }
            .label-code {
              font-size: 13px;
              font-weight: 700;
              font-family: monospace;
              margin: 4px 0;
              color: #000000;
            }
            .label-qr, .barcode-svg {
              width: 110px;
              height: 110px;
              image-rendering: -moz-crisp-edges !important;
              image-rendering: -webkit-crisp-edges !important;
              image-rendering: pixelated !important;
              image-rendering: crisp-edges !important;
            }
            .barcode-svg {
              max-width: 100%;
              height: 48px;
            }
            .label-footer {
              font-size: 9px;
              color: #64748b;
              width: 100%;
              text-align: left;
              border-top: 1px solid #f1f5f9;
              padding-top: 4px;
              margin-top: 4px;
            }
            @media print {
              .no-print { display: none; }
              body { margin: 0; }
              .grid-container {
                gap: 10px;
              }
              .label-card {
                border: 1px solid #000000;
              }
            }
          </style>
        </head>
        <body>
          <div class="no-print">
            <button onclick="window.print()" style="padding: 8px 16px; background: #2563eb; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 13px;">Print Labels</button>
            <div style="display: flex; align-items: center; gap: 12px; font-size: 13px; font-weight: 600;">
              <span style="color: #475569;">Format:</span>
              <label style="cursor: pointer; display: flex; align-items: center; gap: 4px;">
                <input type="radio" name="label_type" value="qr" checked onchange="toggleFormat('qr')" /> QR Code
              </label>
              <label style="cursor: pointer; display: flex; align-items: center; gap: 4px;">
                <input type="radio" name="label_type" value="barcode" onchange="toggleFormat('barcode')" /> Barcode (128)
              </label>
            </div>
            <span style="color: #64748b; font-size: 12px;">(Select Save as PDF or your Label Printer in the print dialog)</span>
          </div>
          <div class="grid-container">
            ${labelsHTML}
          </div>
          <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
          <script>
            function initBarcodes() {
              const svgs = document.querySelectorAll('.barcode-svg');
              svgs.forEach(svg => {
                const code = svg.getAttribute('data-code');
                try {
                  JsBarcode(svg, code, {
                    format: "CODE128",
                    width: 1.5,
                    height: 48,
                    displayValue: false,
                    margin: 0
                  });
                } catch (e) {
                  console.error('JsBarcode error:', e);
                }
              });
            }

            function toggleFormat(type) {
              const qrs = document.querySelectorAll('.qr-container');
              const barcodes = document.querySelectorAll('.barcode-container');
              if (type === 'qr') {
                qrs.forEach(el => el.style.display = 'block');
                barcodes.forEach(el => el.style.display = 'none');
              } else {
                qrs.forEach(el => el.style.display = 'none');
                barcodes.forEach(el => el.style.display = 'block');
              }
            }

            window.onload = function() {
              initBarcodes();
              setTimeout(function() {
                window.print();
              }, 600);
            };
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  // --- Submit ---
  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const validItems = issueItems.filter((i) => i.item_id && i.qty > 0);
      if (validItems.length === 0) {
        message.error('Please add at least one item with quantity');
        return;
      }
      const itemsWithoutUOM = validItems.filter((i) => !i.uom_id);
      if (itemsWithoutUOM.length > 0) {
        message.error('UOM is required for all items — please select each item from the lookup');
        return;
      }

      const invalidSerials = validItems.filter(
        (i) => (i.has_serial || i.item_type === 'asset' || i.item_type === 'consumable') && 
               (!i.serial_numbers || i.serial_numbers.length !== Math.round(Number(i.qty)))
      );
      if (invalidSerials.length > 0) {
        message.error('For asset, consumable, or serial-tracked items, selected serial numbers / asset codes count must equal the quantity');
        return;
      }

      const itemsWithoutBatch = isCentralWarehouse
        ? validItems.filter((i) => {
            const selectedBatches = i.batch_ids || (i.batch_id ? [i.batch_id] : []);
            return i.has_batch && selectedBatches.length === 0;
          })
        : []; // non-central WH: batch is optional text, never block submission
      if (itemsWithoutBatch.length > 0) {
        message.error('Batch selection is required for items flagged with batch tracking');
        return;
      }

      const itemsWithNegativeRate = validItems.filter((i) => i.rate < 0);
      if (itemsWithNegativeRate.length > 0) {
        message.error('Rate cannot be negative');
        return;
      }

      const insufficientStock = validItems.filter((i) => {
        const available = stockMap[i.item_id] ?? 0;
        return Number(i.qty) > available;
      });
      if (insufficientStock.length > 0) {
        const msgs = insufficientStock.map((i) => {
          const available = stockMap[i.item_id] ?? 0;
          const batchInfo = i.batch_id ? `batch ${i.batch_id}` : 'No batch';
          const binInfo = i.bin_id ? `bin ${i.bin_id}` : 'No bin';
          return `Insufficient stock for item ${i.item_id} (${batchInfo}, ${binInfo}): available=${available}, requested=${i.qty}`;
        }).join(' ; ');
        message.error(msgs);
        return;
      }

      setSubmitting(true);

      const payloadItems = [];
      for (const item of validItems) {
        const selectedBatches = item.batch_ids || (item.batch_id ? [item.batch_id] : []);
        const selectedBins = item.bin_ids || (item.bin_id ? [item.bin_id] : []);
        const details = itemStockDetails[item.item_id] || {};
        const rawRows = details.rawRows || [];

        const matchingRows = rawRows.filter(r => {
          const matchBatch = selectedBatches.length === 0 || selectedBatches.some(bId => String(bId) === String(r.batch_id));
          const matchBin = selectedBins.length === 0 || selectedBins.some(bId => String(bId) === String(r.bin_id));
          return matchBatch && matchBin && Number(r.available_qty) > 0;
        });

        // Sort matchingRows by expiry date ascending
        matchingRows.sort((a, b) => {
          if (a.expiry_date && b.expiry_date) {
            return new Date(a.expiry_date) - new Date(b.expiry_date);
          }
          if (a.expiry_date) return -1;
          if (b.expiry_date) return 1;
          return 0;
        });

        if (matchingRows.length === 0 || (!item.has_batch && selectedBins.length === 0)) {
          payloadItems.push({
            item_id: item.item_id,
            qty: item.qty,
            uom_id: item.uom_id,
            batch_id: isCentralWarehouse ? (selectedBatches[0] || null) : null,
            bin_id: isCentralWarehouse ? (selectedBins[0] || null) : null,
            rate: item.rate,
            serial_numbers: (item.has_serial || item.item_type === 'asset' || item.item_type === 'consumable') ? item.serial_numbers : null,
            batch_number_text: !isCentralWarehouse ? (item.batch_number_text || null) : null,
            bin_code_text: !isCentralWarehouse ? (item.bin_code_text || null) : null,
          });
          continue;
        }

        let remainingQty = Number(item.qty);
        for (const row of matchingRows) {
          if (remainingQty <= 0) break;
          const avail = Number(row.available_qty) || 0;
          const take = Math.min(avail, remainingQty);
          payloadItems.push({
            item_id: item.item_id,
            qty: take,
            uom_id: item.uom_id,
            batch_id: isCentralWarehouse ? (row.batch_id || null) : null,
            bin_id: isCentralWarehouse ? (row.bin_id || null) : null,
            rate: Number(row.valuation_rate) || item.rate || 0,
            serial_numbers: (item.has_serial || item.item_type === 'asset' || item.item_type === 'consumable') ? item.serial_numbers : null,
            batch_number_text: !isCentralWarehouse ? (item.batch_number_text || null) : null,
            bin_code_text: !isCentralWarehouse ? (item.bin_code_text || null) : null,
          });
          remainingQty -= take;
        }

        if (remainingQty > 0) {
          if (payloadItems.length > 0) {
            payloadItems[payloadItems.length - 1].qty += remainingQty;
          } else {
            payloadItems.push({
              item_id: item.item_id,
              qty: remainingQty,
              uom_id: item.uom_id,
              batch_id: isCentralWarehouse ? (selectedBatches[0] || null) : null,
              bin_id: isCentralWarehouse ? (selectedBins[0] || null) : null,
              rate: item.rate,
              serial_numbers: (item.has_serial || item.item_type === 'asset' || item.item_type === 'consumable') ? item.serial_numbers : null,
              batch_number_text: !isCentralWarehouse ? (item.batch_number_text || null) : null,
              bin_code_text: !isCentralWarehouse ? (item.bin_code_text || null) : null,
            });
          }
        }
      }

      const payload = {
        ...values,
        issue_date: formatDateForAPI(values.issue_date),
        items: payloadItems,
        template_type: templateType || undefined,
      };

      if (!isNew) {
        await api.put(`/warehouse/material-issues/${id}`, payload);
        message.success('Material Issue updated successfully');
        setEditMode(false);
        fetchRecord();
      } else {
        const res = await api.post('/warehouse/material-issues', payload);
        message.success('Material Issue created successfully');
        const newId = res.data?.id;
        if (newId) {
          if (templateType) {
            navigate(`/warehouse/material-issues/ap104-${templateType}/${newId}`);
          } else {
            navigate(`/warehouse/material-issues/${newId}`);
          }
        } else {
          if (templateType) {
            navigate(`/warehouse/material-issues/ap104-${templateType}`);
          } else {
            navigate('/warehouse/material-issues');
          }
        }
      }
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveTreeCodes = (selected) => {
    if (activeRowKey) {
      updateIssueItemFields(activeRowKey, {
        serial_numbers: selected,
        qty: selected.length
      });
    }
    setTreeModalOpen(false);
    setActiveRowKey(null);
  };

  // --- Group Material Issue Items ---
  const groupMaterialIssueItems = (items) => {
    if (!items) return [];
    const grouped = {};
    items.forEach(item => {
      const key = item.item_id || item.item_code || item.item_name;
      if (!grouped[key]) {
        grouped[key] = {
          ...item,
          qty: 0,
          amount: 0,
          batches: new Set(),
          bins: new Set(),
          serial_numbers: [],
          rates: []
        };
      }
      grouped[key].qty += Number(item.qty || 0);
      grouped[key].amount += Number(item.amount || (item.qty * item.rate) || 0);
      if (item.batch_number || item.batch_id) {
        grouped[key].batches.add(String(item.batch_number || item.batch_id));
      }
      if (item.bin_code || item.bin_id) {
        grouped[key].bins.add(String(item.bin_code || item.bin_id));
      }
      if (item.serial_numbers) {
        grouped[key].serial_numbers = [...grouped[key].serial_numbers, ...item.serial_numbers];
      }
      if (item.rate) {
        grouped[key].rates.push(item.rate);
      }
    });

    return Object.values(grouped).map((item, idx) => {
      const avgRate = item.qty > 0 ? (item.amount / item.qty) : (item.rates[0] || item.rate || 0);
      return {
        ...item,
        key: item.item_id || idx,
        batch_id: Array.from(item.batches).join(', ') || '-',
        bin_id: Array.from(item.bins).join(', ') || '-',
        rate: avgRate
      };
    });
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}>
        <Spin size="large" />
      </div>
    );
  }

  // --- VIEW MODE ---
  if (!isNew && recordData && !editMode) {
    const viewItemColumns = [
      { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
      { title: 'Item', dataIndex: 'item_name', width: 200, ellipsis: true, render: (v, r) => v || r.item_code || '-' },
      { title: 'Qty', dataIndex: 'qty', width: 90, align: 'right', render: (v) => formatNumber(v) },
      { title: 'UOM', dataIndex: 'uom_name', width: 80, render: (v) => v || '-' },
      { title: 'Batch', dataIndex: 'batch_id', width: 120, render: (v, r) => r.batch_number || r.batch_number_text || v || '-' },
      { title: 'Bin', dataIndex: 'bin_id', width: 120, render: (v, r) => r.bin_code || r.bin_code_text || v || '-' },
      {
        title: 'Serial Numbers',
        dataIndex: 'serial_numbers',
        width: 150,
        render: (serials, record) => {
          if (!serials || serials.length === 0) return '-';
          const matCode = record.item_code || '';
          const prefix = matCode ? `${matCode}-1-` : '';
          const parsed = serials.map(s => {
            if (prefix && s.startsWith(prefix)) {
              return s.slice(prefix.length);
            }
            if (s.startsWith('1-') && s.endsWith(`-${matCode}`)) {
              return s.slice(2, -matCode.length - 1);
            }
            return s;
          });
          return (
            <Tooltip title={parsed.join(', ')}>
              <div style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {parsed.map((s) => <Tag key={s} color="blue">{s}</Tag>)}
              </div>
            </Tooltip>
          );
        }
      },
      {
        title: 'Asset/Consumable Codes',
        dataIndex: 'serial_numbers',
        width: 150,
        render: (serials, record) => {
          const isAsset = record.item_type === 'asset';
          const isConsumable = record.item_type === 'consumable';
          if (!isAsset && !isConsumable) return '-';
          if (!serials || serials.length === 0) return '-';
          const matCode = record.item_code || '';
          const prefix = matCode ? `${matCode}-1-` : '';
          const parsed = serials.map(s => {
            if (prefix && s.startsWith(prefix)) {
              return s;
            }
            return `${prefix}${s}`;
          });
          return (
            <Tooltip title={parsed.join(', ')}>
              <div style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {parsed.map((s) => <Tag key={s} color={isAsset ? "cyan" : "orange"}>{s}</Tag>)}
              </div>
            </Tooltip>
          );
        }
      },
      { title: 'Rate', dataIndex: 'rate', width: 110, align: 'right', render: (v) => formatCurrency(v) },
      { title: 'Amount', dataIndex: 'amount', width: 120, align: 'right', render: (v) => <Text strong>{formatCurrency(v)}</Text> },
    ];

    return (
      <div>
        <PageHeader
          title={recordData.issue_number || `Issue #${id}`}
          subtitle="Material Issue Details"
        >
          <Space>
            {recordData.items && recordData.items.some(item => item.serial_numbers && item.serial_numbers.length > 0) && (
              <Button icon={<QrcodeOutlined />} onClick={handlePrintAllIssueQRs} style={{ background: '#f0fdf4', color: '#16a34a', borderColor: '#bbf7d0', fontWeight: 600 }}>
                Print QR Labels
              </Button>
            )}
            {recordData.status === 'draft' && (
              <>
                <Button icon={<EditOutlined />} onClick={() => setEditMode(true)} type="primary">
                  Edit
                </Button>
                <Popconfirm title="Issue this material? Stock will be reserved." onConfirm={handleIssue}>
                  <Button type="default" icon={<SendOutlined />} style={{ color: '#eb2f96' }}>Issue</Button>
                </Popconfirm>
                <Popconfirm title="Delete this Material Issue?" onConfirm={handleDelete} okButtonProps={{ danger: true }}>
                  <Button danger icon={<DeleteOutlined />}>Delete</Button>
                </Popconfirm>
              </>
            )}
            {recordData.status === 'dispatched' && (
              <Popconfirm title="Acknowledge delivery for this Material Issue?" onConfirm={handleAcknowledge}>
                <Button type="primary" icon={<CheckOutlined />}>Acknowledge</Button>
              </Popconfirm>
            )}
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(backPath)}>
              Back
            </Button>
          </Space>
        </PageHeader>

        <Card style={{ marginBottom: 16 }}>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label="Issue Number">{recordData.issue_number}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={recordData.status} /></Descriptions.Item>
            <Descriptions.Item label="Issue Date">{formatDate(recordData.issue_date)}</Descriptions.Item>
            <Descriptions.Item label="Source Warehouse">{recordData.warehouse_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Destination Warehouse">{recordData.destination_warehouse_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Department">{recordData.department || '-'}</Descriptions.Item>
            <Descriptions.Item label="Issued To">{recordData.issued_to_name || recordData.issued_to || '-'}</Descriptions.Item>

            <Descriptions.Item label="Indent Reference">{recordData.indent_number || recordData.indent_id || '-'}</Descriptions.Item>
            <Descriptions.Item label="Vehicle Code">{recordData.vehicle_code || '-'}</Descriptions.Item>
            <Descriptions.Item label="Vehicle Number">{recordData.vehicle_number || '-'}</Descriptions.Item>
            <Descriptions.Item label="Service Code">{recordData.service_code || '-'}</Descriptions.Item>
            <Descriptions.Item label="Remarks" span={3}>{recordData.remarks || '-'}</Descriptions.Item>
          </Descriptions>
        </Card>

        <Card title="Material Issue Items">
          <Table
            dataSource={groupMaterialIssueItems(recordData.items || [])}
            columns={viewItemColumns}
            rowKey="id"
            pagination={false}
            size="small"
            scroll={{ x: 800 }}
          />
        </Card>
      </div>
    );
  }

  // --- EDIT / CREATE MODE ---
  const issueItemColumns = [
    { title: '#', width: 35, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item',
      dataIndex: 'item_id',
      width: 220,
      render: (val, record) =>
        record.item_name ? (
          <Tooltip title={record.item_name}>
            <Text ellipsis style={{ maxWidth: 200 }}>{record.item_name}</Text>
          </Tooltip>
        ) : (
          <ItemSelector
            value={val}
            onChange={async (itemId, item) => {
              updateIssueItem(record.key, 'item_id', itemId);
              if (item) {
                updateIssueItem(record.key, 'item_name', item.item_name || item.name || '');
                updateIssueItem(record.key, 'item_code', item.item_code || item.code || '');
                updateIssueItem(record.key, 'item_type', item.item_type || '');
                updateIssueItem(record.key, 'batch_id', null);
                updateIssueItem(record.key, 'bin_id', null);
                updateIssueItem(record.key, 'serial_numbers', []);
                updateIssueItem(record.key, 'uom_id', item.primary_uom_id || item.uom_id || null);
                updateIssueItem(record.key, 'has_batch', !!item.has_batch);
                updateIssueItem(record.key, 'has_serial', !!item.has_serial);

                const warehouseId = form.getFieldValue('warehouse_id');
                if (warehouseId && itemId) {
                  await refreshStockForItems(warehouseId, [itemId]);
                  await fetchItemStockDetails(warehouseId, itemId);
                  let autoRate = item.last_purchase_rate || item.rate || 0;
                  if (!autoRate) {
                    autoRate = rateMap[itemId] || 0;
                  }
                  if (!autoRate) {
                    const details = itemStockDetails[itemId] || { batches: [] };
                    const batchWithRate = details.batches.find(b => b.rate && b.rate > 0);
                    if (batchWithRate) {
                      autoRate = batchWithRate.rate;
                    }
                  }
                  updateIssueItem(record.key, 'rate', autoRate);
                }
              }
            }}
            style={{ width: '100%' }}
          />
        ),
    },
    {
      title: 'Qty',
      dataIndex: 'qty',
      width: 120,
      render: (val, record) => {
        const disabled = !record.item_id;
        return (
          <Tooltip title={disabled ? 'Select an item first' : ''}>
            <InputNumber
              min={0}
              value={val}
              disabled={disabled}
              onChange={(v) => updateIssueItem(record.key, 'qty', v || 0)}
              style={{ width: '100%' }}
              size="small"
              status={
                record.item_id && stockMap[record.item_id] != null && (val || 0) > stockMap[record.item_id]
                  ? 'error'
                  : ''
              }
            />
          </Tooltip>
        );
      },
    },
    {
      title: 'Available',
      dataIndex: 'item_id',
      width: 90,
      render: (itemId) => {
        if (!itemId) return <Text type="secondary">—</Text>;
        const avail = stockMap[itemId];
        if (avail == null) return <Text type="secondary">—</Text>;
        return (
          <Text strong style={{ color: avail > 0 ? '#2E7D52' : '#D80048' }}>
            {formatNumber(avail)}
          </Text>
        );
      },
    },
    {
      title: 'UOM',
      dataIndex: 'uom_id',
      width: 110,
      render: (val, record) => (
        <Select
          value={val}
          onChange={(v) => updateIssueItem(record.key, 'uom_id', v)}
          options={uomOptions}
          placeholder="UOM"
          size="small"
          style={{ width: '100%' }}
          showSearch
          optionFilterProp="label"
        />
      ),
    },
    {
      title: 'Batch No.',
      dataIndex: 'batch_id',
      width: 200,
      render: (val, record) => {
        const warehouseId = form.getFieldValue('warehouse_id');
        const details = itemStockDetails[record.item_id] || { batches: [], bins: [] };
        if (!record.item_id || !warehouseId) {
          return (
            <Select
              value={val}
              disabled
              placeholder={!record.item_id ? 'Select item first' : 'Select warehouse'}
              size="small"
              style={{ width: '100%' }}
            />
          );
        }

        const quantityMissing = !record.qty || Number(record.qty) <= 0;

        // Non-central warehouse: breakdown returns batch_id=null for all rows.
        // Show an optional text input for source batch traceability (no ledger validation).
        const allBatchIdsNull = details.batches.length > 0 && details.batches.every(b => b.id === null);
        if (allBatchIdsNull || !isCentralWarehouse) {
          // Non-central: always show free-text input
          return (
            <Input
              value={record.batch_number_text || ''}
              onChange={(e) => updateIssueItem(record.key, 'batch_number_text', e.target.value)}
              placeholder={quantityMissing ? "Enter quantity first" : "Source batch # (optional)"}
              disabled={quantityMissing}
              size="small"
              style={{ width: '100%' }}
              allowClear
            />
          );
        }

        if (quantityMissing) {
          return (
            <Select
              value={val}
              disabled
              placeholder="Enter quantity first"
              size="small"
              style={{ width: '100%' }}
            />
          );
        }

        if (!record.has_batch && details.batches.length === 0) {
          return (
            <Select
              value={val}
              disabled
              placeholder="Not required"
              size="small"
              style={{ width: '100%' }}
            />
          );
        }
        if (record.has_batch && details.batches.length === 0) {
          // Show saved batch_number if available even though breakdown has no rows yet
          const savedBatchLabel = record.batch_number || (record.batch_id ? `Batch #${record.batch_id}` : null);
          if (savedBatchLabel) {
            return <Tag color="blue" style={{ margin: 0 }}>{savedBatchLabel}</Tag>;
          }
          return (
            <Select
              value={val}
              disabled
              placeholder="No batches in stock"
              size="small"
              style={{ width: '100%' }}
            />
          );
        }
        // Sort and filter batches based on requested qty and expiry date
        let displayedBatches = [...details.batches];
        displayedBatches.sort((a, b) => {
          if (a.expiry_date && b.expiry_date) {
            return new Date(a.expiry_date) - new Date(b.expiry_date);
          }
          if (a.expiry_date) return -1;
          if (b.expiry_date) return 1;
          return 0;
        });

        const targetQty = record.qty || 0;
        const selectedBatchIds = new Set(
          record.batch_ids || (record.batch_id ? [record.batch_id] : [])
        );

        if (targetQty > 0) {
          let accumulatedQty = 0;
          const filtered = [];
          for (const b of displayedBatches) {
            if (accumulatedQty < targetQty || selectedBatchIds.has(b.id)) {
              filtered.push(b);
              accumulatedQty += b.qty || 0;
            }
          }
          displayedBatches = filtered;
        }

        return (
          <Select
            mode="multiple"
            value={record.batch_ids || (record.batch_id ? [record.batch_id] : [])}
            onChange={(selectedValues) => {
              const firstBatchId = selectedValues[0] || null;
              let rateUpdate = {};
              if (firstBatchId !== null) {
                const details = itemStockDetails[record.item_id] || { batches: [] };
                const selectedBatch = details.batches.find((b) => b.id === firstBatchId);
                if (selectedBatch && selectedBatch.rate > 0) {
                  rateUpdate = { rate: selectedBatch.rate };
                }
              }

              // Filter current bin selection to only bins that are valid for the new batch selection
              let updatedBinIds = record.bin_ids || (record.bin_id ? [record.bin_id] : []);
              if (selectedValues.length > 0) {
                const details = itemStockDetails[record.item_id] || { rawRows: [] };
                const validBinIds = new Set(
                  (details.rawRows || [])
                    .filter(r => selectedValues.some(bId => String(bId) === String(r.batch_id)))
                    .map(r => r.bin_id)
                );
                updatedBinIds = updatedBinIds.filter(bId => validBinIds.has(bId));
              } else if (record.has_batch) {
                updatedBinIds = [];
              }

              updateIssueItemFields(record.key, {
                batch_ids: selectedValues,
                batch_id: firstBatchId,
                bin_ids: updatedBinIds,
                bin_id: updatedBinIds[0] || null,
                serial_numbers: [],
                ...rateUpdate
              });
            }}
            options={displayedBatches.map((b) => ({
              label: `${b.batch_number}${b.expiry_date ? ` (Exp: ${b.expiry_date})` : ''}${b.rate > 0 ? ` — ₹${b.rate}` : ''} - Qty: ${formatNumber(b.qty)}`,
              value: b.id,
            }))}
            placeholder="Select batch(es)"
            size="small"
            style={{ width: '100%' }}
            allowClear
            showSearch
            optionFilterProp="label"
          />
        );
      },
    },
    {
      title: 'Bin Code',
      dataIndex: 'bin_id',
      width: 160,
      render: (val, record) => {
        const warehouseId = form.getFieldValue('warehouse_id');
        const details = itemStockDetails[record.item_id] || { batches: [], bins: [], rawRows: [] };
        if (!record.item_id || !warehouseId) {
          return (
            <Select
              value={val}
              disabled
              placeholder={!record.item_id ? 'Select item first' : 'Select warehouse'}
              size="small"
              style={{ width: '100%' }}
            />
          );
        }

        const selectedBatches = record.batch_ids || (record.batch_id ? [record.batch_id] : []);
        if (record.has_batch && selectedBatches.length === 0) {
          return (
            <Select
              value={val}
              disabled
              placeholder="Select batch first"
              size="small"
              style={{ width: '100%' }}
            />
          );
        }

        let binOptions = details.bins;
        if (selectedBatches.length > 0) {
          const filteredRows = (details.rawRows || []).filter(r =>
            selectedBatches.some(bId => String(bId) === String(r.batch_id))
          );
          const filteredBinMap = new Map();
          filteredRows.forEach((r) => {
            const bnid = r.bin_id;
            const bCode = r.bin_code || r.bin_name || (bnid ? `Bin ${bnid}` : 'General Area');
            const bnidKey = bnid === null ? 'null_bin' : bnid;
            if (!filteredBinMap.has(bnidKey)) {
              filteredBinMap.set(bnidKey, {
                id: bnid,
                code: bCode,
                qty: Number(r.available_qty) || 0,
              });
            } else {
              filteredBinMap.get(bnidKey).qty += Number(r.available_qty) || 0;
            }
          });
          binOptions = Array.from(filteredBinMap.values());
        }

        if (binOptions.length === 0) {
          // Non-central: show optional text input for bin/location traceability
          if (!isCentralWarehouse) {
            return (
              <Input
                value={record.bin_code_text || ''}
                onChange={(e) => updateIssueItem(record.key, 'bin_code_text', e.target.value)}
                placeholder="Source location (optional)"
                size="small"
                style={{ width: '100%' }}
                allowClear
              />
            );
          }
          return (
            <Select
              value={val}
              disabled
              placeholder="No bins available"
              size="small"
              style={{ width: '100%' }}
            />
          );
        }
        return (
          <Select
            mode="multiple"
            value={record.bin_ids || (record.bin_id ? [record.bin_id] : [])}
            onChange={(selectedValues) => {
              updateIssueItemFields(record.key, {
                bin_ids: selectedValues,
                bin_id: selectedValues[0] || null,
                serial_numbers: [],
              });
            }}
            options={binOptions.map((b) => ({
              label: `${b.code} - Qty: ${formatNumber(b.qty)}`,
              value: b.id,
            }))}
            placeholder="Select bin(s)"
            size="small"
            style={{ width: '100%' }}
            allowClear
            showSearch
            optionFilterProp="label"
          />
        );
      },
    },
    {
      title: 'Serial / Asset Codes',
      dataIndex: 'serial_numbers',
      width: 170,
      render: (val, record) => {
        const details = itemStockDetails[record.item_id] || {};
        const serialsMap = details.serialsMap || {};
        const key = `${record.batch_id || 'null'}-${record.bin_id || 'null'}`;
        const availableSerials = serialsMap[key] || [];
        
        const isAssetOrConsumableOrSerial = record.item_type === 'asset' || record.item_type === 'consumable' || record.has_serial;
        const selectedCount = val?.length || 0;
        const isAsset = record.item_type === 'asset';
        const isConsumable = record.item_type === 'consumable';
        const shadowColor = isAsset ? 'rgba(6,182,212,0.3)' : isConsumable ? 'rgba(249,115,22,0.3)' : 'rgba(99,102,241,0.3)';
        const label = isAsset ? 'Codes Selected' : isConsumable ? 'Codes Selected' : 'Serials Selected';
        const buttonText = isAsset || isConsumable ? 'Select Codes' : 'Select Serials';

        const selectedBatches = record.batch_ids || (record.batch_id ? [record.batch_id] : []);
        const needsBatch = record.has_batch;
        const batchMissing = needsBatch && selectedBatches.length === 0;

        if (batchMissing) {
          if (isAssetOrConsumableOrSerial) {
            return (
              <Tooltip title="Select batch first">
                <Button
                  size="small"
                  disabled
                  icon={<BarcodeOutlined />}
                  style={{
                    borderRadius: '20px',
                    fontSize: '11px',
                  }}
                >
                  {buttonText}
                </Button>
              </Tooltip>
            );
          }
          return (
            <Tooltip title="Select batch first">
              <span style={{ color: 'rgba(0, 0, 0, 0.25)', cursor: 'not-allowed', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 20, border: '1.5px solid #d9d9d9', background: '#f5f5f5' }}>
                <BarcodeOutlined /> Select S/N
              </span>
            </Tooltip>
          );
        }
        
        if (isAssetOrConsumableOrSerial) {
          return (
            <Tooltip title="Click to select specific items/serials from tree hierarchy">
              <Button
                size="small"
                type={selectedCount > 0 ? "primary" : "dashed"}
                icon={<BarcodeOutlined />}
                onClick={() => {
                  setActiveRowKey(record.key);
                  setTreeModalOpen(true);
                }}
                style={{
                  borderRadius: '20px',
                  fontWeight: 600,
                  fontSize: '11px',
                  boxShadow: selectedCount > 0 ? `0 2px 6px ${shadowColor}` : 'none'
                }}
              >
                {selectedCount > 0 ? `${selectedCount} ${label}` : buttonText}
              </Button>
            </Tooltip>
          );
        }

        return (
          <SerialNumbersModal
            value={val || []}
            onChange={(updated) => updateIssueItem(record.key, 'serial_numbers', updated)}
            itemName={record.item_name}
            itemCode={record.item_code}
            quantity={Math.round(Number(record.qty || 0))}
            hasSerial={record.has_serial}
            size="small"
            mode="select"
            availableSerials={availableSerials}
          />
        );
      },
    },
    {
      title: 'Rate',
      dataIndex: 'rate',
      width: 120,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateIssueItem(record.key, 'rate', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      width: 110,
      align: 'right',
      render: (val) => <Text strong style={{ fontSize: 12 }}>{formatCurrency(val)}</Text>,
    },
    {
      title: '',
      width: 35,
      render: (_, record) =>
        issueItems.length > 1 ? (
          <MinusCircleOutlined
            style={{ color: '#ff4d4f', cursor: 'pointer' }}
            onClick={() => removeItemRow(record.key)}
          />
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title={propTitle || (isNew ? 'Create Material Issue' : `Edit Material Issue`)}
        subtitle="Manage material issues from warehouse details"
      >
        <Space>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSubmit}
            loading={submitting}
          >
            Save
          </Button>
          <Button
            onClick={() => {
              if (isNew) {
                navigate(backPath);
              } else {
                setEditMode(false);
              }
            }}
          >
            Cancel
          </Button>
        </Space>
      </PageHeader>

      <Card style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical">
          {templateType ? (
            <>
              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item name="project_id" label="Project" rules={[{ required: true, message: 'Required' }]}>
                    <Select
                      options={projects}
                      placeholder="Select project"
                      showSearch
                      optionFilterProp="label"
                      disabled={!isNew}
                      onChange={(val) => prefillFromTemplate(val, templateType)}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="warehouse_id" label="Warehouse" rules={[{ required: true, message: 'Required' }]}>
                    <Select
                      options={warehouses}
                      placeholder="Select warehouse"
                      showSearch
                      optionFilterProp="label"
                      onChange={(whId) => {
                        const itemIds = issueItems.map((l) => l.item_id).filter(Boolean);
                        refreshStockForItems(whId, itemIds);
                        itemIds.forEach((id) => fetchItemStockDetails(whId, id));
                        setIssueItems(issueItems.map(i => ({ ...i, batch_id: null, bin_id: null })));
                      }}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="destination_warehouse_id" label="Destination Warehouse">
                    <Select
                      options={allWarehouses}
                      placeholder="Select destination warehouse"
                      allowClear
                      showSearch
                      optionFilterProp="label"
                    />
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item name="department" label="Department">
                    <Input placeholder="Department name" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="issued_to" label="Issued To">
                    <Select
                      options={userOptions}
                      placeholder="Select user"
                      showSearch
                      optionFilterProp="label"
                      allowClear
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="issue_date" label="Issue Date" rules={[{ required: true, message: 'Required' }]}>
                    <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={16}>
                <Col span={24}>
                  <Form.Item name="remarks" label="Remarks">
                    <Input placeholder="Any remarks" />
                  </Form.Item>
                </Col>
              </Row>
            </>
          ) : (
            <>
              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item name="warehouse_id" label="Warehouse" rules={[{ required: true, message: 'Required' }]}>
                    <Select
                      options={warehouses}
                      placeholder="Select warehouse"
                      showSearch
                      optionFilterProp="label"
                      onChange={(whId) => {
                        const itemIds = issueItems.map((l) => l.item_id).filter(Boolean);
                        refreshStockForItems(whId, itemIds);
                        itemIds.forEach((id) => fetchItemStockDetails(whId, id));
                        setIssueItems(issueItems.map(i => ({ ...i, batch_id: null, bin_id: null })));
                      }}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="department" label="Department">
                    <Input placeholder="Department name" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="issue_date" label="Issue Date" rules={[{ required: true, message: 'Required' }]}>
                    <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item
                    name="indent_id"
                    label="Indent (auto-loads items)"
                    tooltip="Pick an approved indent — warehouse + items + remaining qty are filled in for you."
                  >
                    <Select
                      options={indentOptions}
                      placeholder="Pick approved indent to issue against"
                      showSearch
                      optionFilterProp="label"
                      allowClear
                      onFocus={() => loadIndentOptions()}
                      onSearch={(v) => loadIndentOptions(v)}
                      onChange={(v) => prefillFromIndent(v)}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item
                    noStyle
                    shouldUpdate={(prevValues, currentValues) => prevValues.indent_id !== currentValues.indent_id}
                  >
                    {({ getFieldValue }) => (
                      <Form.Item name="destination_warehouse_id" label="Destination Warehouse">
                        <Select
                          options={allWarehouses}
                          placeholder="Select destination warehouse"
                          allowClear
                          showSearch
                          optionFilterProp="label"
                          disabled={!!getFieldValue('indent_id')}
                        />
                      </Form.Item>
                    )}
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item name="issued_to" label="Issued To">
                    <Select
                      options={userOptions}
                      placeholder="Select user"
                      showSearch
                      optionFilterProp="label"
                      allowClear
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="remarks" label="Remarks">
                    <Input placeholder="Any remarks" />
                  </Form.Item>
                </Col>
              </Row>
            </>
          )}

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="vehicle_code" label="Vehicle Code">
                {templateType ? (
                  <Select
                    placeholder="Select vehicle code"
                    allowClear
                    showSearch
                    filterOption={false}
                    onSearch={loadVehicleOptions}
                    onFocus={() => loadVehicleOptions()}
                    onChange={handleVehicleChange}
                    loading={vehiclesLoading}
                    options={vehicles.map((v) => ({ label: `${v.vehicle_code} (${v.vehicle_number})`, value: v.vehicle_code }))}
                  />
                ) : (
                  <Input placeholder="Auto-loaded from Indent" disabled style={{ color: 'rgba(0, 0, 0, 0.85)', backgroundColor: '#fafafa' }} />
                )}
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="vehicle_number" label="Vehicle Number">
                <Input placeholder={templateType ? "Auto-populated from code" : "Auto-loaded from Indent"} disabled={!templateType} style={!templateType ? { color: 'rgba(0, 0, 0, 0.85)', backgroundColor: '#fafafa' } : {}} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="service_code" label="Service Code">
                <Input placeholder={templateType ? "Enter service code" : "Auto-loaded from Indent"} disabled={!templateType} style={!templateType ? { color: 'rgba(0, 0, 0, 0.85)', backgroundColor: '#fafafa' } : {}} />
              </Form.Item>
            </Col>
          </Row>

        </Form>
      </Card>

      <Card title="Material Issue Items">
        <Table
          dataSource={issueItems}
          columns={issueItemColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 1350 }}
          footer={() => (
            <Button type="dashed" onClick={addItemRow} icon={<PlusOutlined />} block>
              Add Item
            </Button>
          )}
        />

        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ width: 380 }}>
            <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Col span={14}><Text>Total Qty:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}><Text strong>{formatNumber(calcTotalQty())}</Text></Col>
            </Row>
            <Row style={{ padding: '8px 0', background: '#fafafa', borderRadius: 4, marginTop: 4 }}>
              <Col span={14}><Text strong style={{ fontSize: 16 }}>Total Amount:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}>
                <Text strong style={{ fontSize: 16, color: '#eb2f96' }}>{formatCurrency(calcTotalAmount())}</Text>
              </Col>
            </Row>
          </div>
        </div>
      </Card>

      {/* Tree Modal for Asset/Consumable Codes Selection */}
      {activeTreeRow && (
        <AssetCodesTreeModal
          open={treeModalOpen}
          onCancel={() => {
            setTreeModalOpen(false);
            setActiveRowKey(null);
          }}
          onSave={handleSaveTreeCodes}
          selectedCodes={activeTreeRow.serial_numbers || []}
          rawRows={itemStockDetails[activeTreeRow.item_id]?.rawRows || []}
          itemCode={activeTreeRow.item_code}
          itemName={activeTreeRow.item_name}
          itemType={activeTreeRow.item_type}
          batchIds={activeTreeRow.batch_ids || (activeTreeRow.batch_id ? [activeTreeRow.batch_id] : [])}
          binIds={activeTreeRow.bin_ids || (activeTreeRow.bin_id ? [activeTreeRow.bin_id] : [])}
          targetQty={activeTreeRow.qty}
        />
      )}
    </div>
  );
};

export default MaterialIssueForm;
