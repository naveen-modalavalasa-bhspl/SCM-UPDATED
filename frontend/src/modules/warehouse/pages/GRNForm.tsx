// @ts-nocheck
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Button, Form, Input, InputNumber, Select, Space, DatePicker,
  Row, Col, Table, Card, Descriptions, Divider,
  Typography, Tooltip, Tag, Spin, Popconfirm, Alert, Badge, App,
} from 'antd';
import {
  PlusOutlined, ArrowLeftOutlined, SaveOutlined,
  SendOutlined, MinusCircleOutlined, CheckOutlined,
  CloseCircleOutlined, EditOutlined, ExperimentOutlined, PrinterOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useReactToPrint } from 'react-to-print';
import PageHeader from '../components/PageHeader';
import { PurchaseReceiptPrint } from '../components/PrintTemplates';
import StatusTag from '../components/StatusTag';
import ItemSelector from '../components/ItemSelector';
import api from '../config/api';
import {
  formatDate, formatCurrency, formatNumber, getErrorMessage,
  formatDateForAPI, formatDateTime,
} from '../utils/helpers';
import { DATE_FORMAT } from '../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const RECEIPT_TYPES = [
  { label: 'Inward Based', value: 'inward_based' },
  { label: 'Direct', value: 'direct' },
  { label: 'Return', value: 'return' },
  { label: 'Transfer', value: 'transfer' },
];

// BUG-INV-128: include the full enum so the FE status pill / progress bar can
// render every state the backend can emit. Previous list missed qi_done,
// putaway_pending, partially_putaway, putaway_done, and cancelled — the
// "completed" tail was reachable but intermediate inventory states stayed
// blank.
const GRN_STATUS_FLOW = [
  'draft',
  'pending_qi',
  'qi_in_progress',
  'qi_done',
  'putaway_pending',
  'partially_putaway',
  'putaway_done',
  'completed',
  'cancelled',
];

const GRNForm = () => {
  const { message } = App.useApp();
  const [errorAlert, setErrorAlert] = useState(null);
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isNew = !id || id === 'new';
  const printRef = useRef(null);
  const handlePrint = useReactToPrint({ content: () => printRef.current, documentTitle: `GRN` });

  // Extract po_id from query params (e.g. /warehouse/grn/new?po_id=5)
  const queryParams = new URLSearchParams(location.search);
  const queryPoId = queryParams.get('po_id');

  const isEdit = new URLSearchParams(location.search).get('edit') === 'true';
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [grn, setGrn] = useState(null);
  const [editMode, setEditMode] = useState(isNew || isEdit);

  // Items
  const [grnItems, setGrnItems] = useState([]);

  // Receipt type
  const [receiptType, setReceiptType] = useState('inward_based');

  // Lookups
  const [vendors, setVendors] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [uoms, setUoms] = useState([]);
  const [poOptions, setPoOptions] = useState([]);
  const [selectedPO, setSelectedPO] = useState(null);
  const [loadingPO, setLoadingPO] = useState(false);
  const [inwardOptions, setInwardOptions] = useState([]);
  const [loadingInwards, setLoadingInwards] = useState(false);
  const [selectedInward, setSelectedInward] = useState(null);

  // --- Empty item row ---
  const createEmptyItem = () => ({
    key: Date.now() + Math.random(),
    item_id: null,
    item_name: '',
    item_code: '',
    po_item_id: null,
    ordered_qty: 0,
    received_qty: 0,
    accepted_qty: 0,
    rejected_qty: 0,
    damaged_qty: 0,
    uom_id: null,
    uom: '',
    batch_number: '',
    manufacturing_date: null,
    expiry_date: null,
    rate: 0,
    amount: 0,
    remarks: '',
    serial_numbers: [],
    item_type: null,
    has_serial: false,
  });

  // --- Load lookups ---
  const loadLookups = useCallback(async () => {
    try {
      const [vendorRes, whRes, uomRes] = await Promise.allSettled([
        api.get('/masters/vendors', { params: { page_size: 200, status: 'active' } }),
        api.get('/masters/warehouses', { params: { page_size: 200, exclude_virtual: true } }),
        api.get('/masters/uom', { params: { page_size: 200 } }),
      ]);
      if (vendorRes.status === 'fulfilled') {
        const d = vendorRes.value.data;
        const items = d.items || d.data || d || [];
        setVendors(items.map((v) => ({
          label: `[${v.vendor_code || v.code || ''}] ${v.name}`,
          value: v.id,
          vendor: v,
        })));
      }
      if (whRes.status === 'fulfilled') {
        const w = whRes.value.data;
        setWarehouses(
          (w.items || w.data || w || []).map((i) => ({
            label: i.name || i.warehouse_name,
            value: i.id,
          }))
        );
      }
      if (uomRes.status === 'fulfilled') {
        const u = uomRes.value.data;
        const items = u.items || u.data || u || [];
        setUoms(items.map((i) => ({
          label: `${i.name} (${i.abbreviation || ''})`,
          value: i.id,
        })));
      }
    } catch {
      // silent
    }
  }, []);

  const loadPOOptions = useCallback(async (search = '') => {
    try {
      // Bug fix BUG_0040/0061/0081/0090: include POs in any state where receiving
      // is still allowed. Previously only 'approved' was shown — POs in
      // 'partially_received' (mid-shipment) were invisible.
      const res = await api.get('/procurement/purchase-orders', {
        params: { page_size: 100, search, status: 'approved,partially_received' },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setPoOptions(
        items.map((po) => ({
          label: `${po.po_number} - ${po.vendor_name || ''}`,
          value: po.id,
          po,
        }))
      );
      if (items.length === 0) {
        message.info('No purchase orders available for receipt. Approve a PO first or change receipt type.');
      }
    } catch (e) {
      message.error('Failed to load purchase orders. ' + (e?.response?.data?.detail || e?.message || ''));
    }
  }, []);

  // --- Inward Options ---
  const loadInwardOptions = useCallback(async (search = '') => {
    setLoadingInwards(true);
    try {
      const res = await api.get('/warehouse/inwards', {
        params: { page_size: 100, search, status: 'received' },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setInwardOptions(
        items.map((inw) => ({
          label: `${inw.inward_number} - ${inw.vendor_name || inw.vendor_name_manual || ''}`,
          value: inw.id,
          inward: inw,
        }))
      );
    } catch {
      // silent
    } finally {
      setLoadingInwards(false);
    }
  }, []);

  // Fetch item_type and has_serial for any rows that are missing it (e.g. loaded from PO/inward)
  const enrichItemTypes = async (rows) => {
    const missing = rows.filter(r => r.item_id && !r.item_type && !r.has_serial);
    if (missing.length === 0) return rows;
    try {
      const ids = [...new Set(missing.map(r => r.item_id))];
      const results = await Promise.allSettled(
        ids.map(id => api.get(`/masters/items/${id}`))
      );
      const typeMap = {};
      results.forEach((res, i) => {
        if (res.status === 'fulfilled') {
          typeMap[ids[i]] = {
            item_type: res.value.data?.item_type || null,
            has_serial: !!(res.value.data?.has_serial),
          };
        }
      });
      return rows.map(r => ({
        ...r,
        item_type: r.item_type || typeMap[r.item_id]?.item_type || null,
        has_serial: r.has_serial || typeMap[r.item_id]?.has_serial || false,
      }));
    } catch {
      return rows;
    }
  };

  // --- Inward Selection ---
  const handleInwardSelect = async (inwardId) => {
    if (!inwardId) {
      setSelectedInward(null);
      setSelectedPO(null);
      setGrnItems([createEmptyItem()]);
      form.setFieldsValue({ po_number: null });
      return;
    }
    setLoadingPO(true);
    try {
      const res = await api.get(`/warehouse/inwards/${inwardId}`);
      const inwardData = res.data;
      setSelectedInward(inwardData);

      // Auto-fill vendor
      if (inwardData.vendor_id) {
        form.setFieldsValue({ vendor_id: inwardData.vendor_id });
      }

      // Auto-fill warehouse
      if (inwardData.warehouse_id) {
        form.setFieldsValue({ warehouse_id: inwardData.warehouse_id });
      }

      // Auto-fill PO number from inward
      form.setFieldsValue({ po_number: inwardData.po_number || null });

      // Auto-fill vehicle number
      if (inwardData.vehicle_number) {
        form.setFieldsValue({ vehicle_number: inwardData.vehicle_number });
      }

      // If inward is PO-linked, fetch PO to get rates and po_item_id mapping
      let poItemsMap = {};
      if (inwardData.po_id) {
        try {
          const poRes = await api.get(`/procurement/purchase-orders/${inwardData.po_id}`);
          const poData = poRes.data;
          setSelectedPO(poData);
          form.setFieldsValue({ po_id: inwardData.po_id });

          if (poData.items) {
            poData.items.forEach((item) => {
              poItemsMap[item.item_id] = item;
            });
          }
        } catch (poErr) {
          console.error('Failed to fetch related PO', poErr);
        }
      } else {
        setSelectedPO(null);
        form.setFieldsValue({ po_id: undefined });
      }

      // Auto-fill items from inward
      const items = (inwardData.items || []).map((item, idx) => {
        const poItem = poItemsMap[item.item_id];
        const rate = poItem ? (poItem.rate || poItem.unit_price || 0) : 0;
        const po_item_id = poItem ? poItem.id : null;
        const ordered_qty = poItem ? (poItem.qty || poItem.quantity || 0) : (item.ordered_qty || 0);

        return {
          key: item.id || Date.now() + idx,
          item_id: item.item_id,
          item_name: item.item_name || item.item_name_manual || '',
          item_code: item.item_code || '',
          po_item_id: po_item_id,
          ordered_qty: ordered_qty,
          received_qty: item.received_qty || 0,
          accepted_qty: item.received_qty || 0,
          rejected_qty: 0,
          damaged_qty: 0,
          uom_id: item.uom_id,
          uom: item.uom_name || item.uom_manual || '',
          batch_number: '',
          manufacturing_date: null,
          expiry_date: null,
          rate: rate,
          amount: Number(((item.received_qty || 0) * rate).toFixed(2)),
          remarks: '',
          serial_numbers: [],
          item_type: null,
          has_serial: false,
        };
      });
      const enriched = await enrichItemTypes(items);
      setGrnItems(enriched.length > 0 ? enriched : [createEmptyItem()]);
      message.success('Material Inward items loaded successfully');
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoadingPO(false);
    }
  };

  // --- Init ---
  useEffect(() => {
    // BUG-INV-129: don't race lookups against PO auto-load with a 500ms timer.
    // Chain explicit awaits so handlePOSelect runs only AFTER lookups + PO
    // option list have actually loaded. Previously, on a slow network the
    // 500ms timeout fired before /procurement/purchase-orders returned and
    // handlePOSelect couldn't find the PO in poOptions, so the form stayed
    // blank with no error.
    let cancelled = false;
    const initAsync = async () => {
      await loadLookups();
      if (cancelled) return;
      if (!isNew) {
        fetchGRN();
        return;
      }
      await loadPOOptions();
      await loadInwardOptions();
      if (cancelled) return;
      form.setFieldsValue({
        receipt_type: 'inward_based',
        grn_date: dayjs(),
      });
      setGrnItems([createEmptyItem()]);
      if (queryPoId) {
        const poId = parseInt(queryPoId, 10);
        if (poId) {
          form.setFieldsValue({ po_id: poId });
          await handlePOSelect(poId);
        }
      }
    };
    initAsync();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // --- Fetch existing GRN ---
  const fetchGRN = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/warehouse/grn/${id}`);
      const data = res.data;
      setGrn(data);
      setReceiptType(data.receipt_type || 'inward_based');
      form.setFieldsValue({
        ...data,
        grn_date: data.grn_date ? dayjs(data.grn_date) : null,
        supplier_invoice_date: data.supplier_invoice_date ? dayjs(data.supplier_invoice_date) : null,
      });
      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_name: item.item_name || (item.item ? `[${item.item.item_code}] ${item.item.item_name || item.item.name}` : ''),
        item_code: item.item_code || (item.item ? item.item.item_code : ''),
        po_item_id: item.po_item_id || null,
        ordered_qty: item.ordered_qty || 0,
        received_qty: item.received_qty || 0,
        uom_id: item.uom_id || null,
        uom: item.uom || '',
        batch_number: item.batch_number || '',
        manufacturing_date: item.manufacturing_date || null,
        expiry_date: item.expiry_date || null,
        rate: item.rate || 0,
        amount: item.amount || 0,
        remarks: item.remarks || '',
        serial_numbers: item.serial_numbers || [],
        item_type: item.item_type || null,
        has_serial: !!(item.has_serial),
      }));
      setGrnItems(items.length > 0 ? items : [createEmptyItem()]);
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/warehouse/grn');
    } finally {
      setLoading(false);
    }
  };

  // --- PO Selection ---
  const handlePOSelect = async (poId) => {
    if (!poId) {
      setSelectedPO(null);
      setGrnItems([createEmptyItem()]);
      return;
    }
    setLoadingPO(true);
    try {
      const res = await api.get(`/procurement/purchase-orders/${poId}`);
      const poData = res.data;
      setSelectedPO(poData);

      // Auto-fill vendor and warehouse
      if (poData.vendor_id) {
        form.setFieldsValue({ vendor_id: poData.vendor_id });
      }
      if (poData.warehouse_id) {
        form.setFieldsValue({ warehouse_id: poData.warehouse_id });
      }

      // Auto-fill items from PO — Bug fix BUG_0011: also carry tax fields
      const items = (poData.items || []).map((item, idx) => {
        const pendingQty = Math.max(0, (item.qty || item.quantity || 0) - (item.received_qty || 0));
        const rate = item.rate || item.unit_price || 0;
        return {
          key: item.id || Date.now() + idx,
          item_id: item.item_id,
          item_name: item.item_name || (item.item ? `[${item.item.item_code}] ${item.item.item_name || item.item.name}` : ''),
          item_code: item.item_code || (item.item ? item.item.item_code : ''),
          po_item_id: item.id,
          ordered_qty: item.qty || item.quantity || 0,
          received_qty: pendingQty,
          uom_id: item.uom_id || null,
          uom: item.uom || item.unit || '',
          batch_number: '',
          manufacturing_date: null,
          expiry_date: null,
          rate,
          // Carry tax + discount from PO line so user doesn't re-enter
          cgst_rate: parseFloat(item.cgst_rate || 0),
          sgst_rate: parseFloat(item.sgst_rate || 0),
          igst_rate: parseFloat(item.igst_rate || 0),
          discount_pct: parseFloat(item.discount_pct || 0),
          amount: Number((pendingQty * rate).toFixed(2)),
          remarks: '',
          serial_numbers: [],
          item_type: item.item_type || null,
          has_serial: !!(item.has_serial),
        };
      });
      const enriched = await enrichItemTypes(items);
      setGrnItems(enriched.length > 0 ? enriched : [createEmptyItem()]);
      message.success('PO items loaded');
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoadingPO(false);
    }
  };

  // --- Item row management ---
  const addItemRow = () => {
    setGrnItems((prev) => [...prev, createEmptyItem()]);
  };

  const removeItemRow = (key) => {
    setGrnItems((prev) => prev.filter((item) => item.key !== key));
  };

  const updateItemRow = (key, field, value) => {
    setGrnItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        const updated = { ...item, [field]: value };
        if (field === 'received_qty' || field === 'rate') {
          updated.amount = Number(((updated.received_qty || 0) * (updated.rate || 0)).toFixed(2));
        }
        return updated;
      })
    );
  };

  // Atomic multi-field update — avoids React state batching issues from
  // multiple sequential setGrnItems calls overwriting each other
  const mergeItemRow = (key, fields) => {
    setGrnItems((prev) =>
      prev.map((row) => {
        if (row.key !== key) return row;
        const updated = { ...row, ...fields };
        if ('received_qty' in fields || 'rate' in fields) {
          updated.amount = Number(((updated.received_qty || 0) * (updated.rate || 0)).toFixed(2));
        }
        return updated;
      })
    );
  };

  // --- Receipt type change ---
  const handleReceiptTypeChange = (value) => {
    setReceiptType(value);
    if (value !== 'inward_based') {
      setSelectedPO(null);
      setSelectedInward(null);
      // Clear inward/po_id value AND reset its validation errors so it doesn't
      // trigger "field required" when the form is submitted for non-inward types
      form.setFields([{ name: 'po_id', value: null, errors: [] }]);
      form.setFields([{ name: 'inward_id', value: null, errors: [] }]);
      form.setFieldsValue({ po_number: null });
      setGrnItems([createEmptyItem()]);
    }
  };

  // --- Totals ---
  const calcTotalQty = () => grnItems.reduce((s, i) => s + (i.received_qty || 0), 0);
  const calcTotalAmount = () => grnItems.reduce((s, i) => s + (i.amount || 0), 0);

  // --- Submit ---
  const handleSubmit = async (submitAction = 'draft') => {
    try {
      setErrorAlert(null);
      // For non-PO receipt types, clear po_id from form store so it doesn't
      // trigger validation errors (Ant Design can retain hidden field state)
      if (receiptType !== 'inward_based') {
        form.setFields([{ name: 'po_id', value: null, errors: [] }]);
      }
      const values = await form.validateFields();
      // Ensure required header fields are present (backend requires vendor_id, warehouse_id, grn_date)
      if (!values.vendor_id) {
        message.error('Vendor is required');
        return;
      }
      if (!values.warehouse_id) {
        message.error('Warehouse is required');
        return;
      }
      if (!values.grn_date) {
        message.error('GRN date is required');
        return;
      }
      // BUG-INV-131: improve the error so the user can tell *why* nothing
      // submitted. Previously rows with received_qty=0 were silently dropped
      // and the user saw a vague "add at least one item" message even though
      // they thought they had filled rows in.
      const itemRowsWithItem = grnItems.filter((i) => i.item_id);
      const validItems = itemRowsWithItem.filter((i) => (i.received_qty || 0) > 0);
      if (validItems.length === 0) {
        if (itemRowsWithItem.length === 0) {
          message.error('Please add at least one item to the GRN');
        } else {
          message.error(
            `All ${itemRowsWithItem.length} item row(s) have received_qty=0 — ` +
              'enter the received quantity for at least one row before saving.'
          );
        }
        return;
      }
      // Validate each item has uom_id (required by backend schema)
      for (const item of validItems) {
        if (!item.uom_id) {
          message.error(`UOM is required for item "${item.item_name || item.item_code || 'Unknown'}". Please select a UOM for all items.`);
          return;
        }
      }
      // Validate each item has batch_number (mandatory for every item)
      const missingBatchItems = validItems.filter((item) => !item.batch_number || !item.batch_number.trim());
      if (missingBatchItems.length > 0) {
        const itemNames = missingBatchItems.map((item) => `"${item.item_name || item.item_code || 'Unknown'}"`).join(', ');
        const errMsg = `Batch number is required for the following item(s): ${itemNames}`;
        setErrorAlert(errMsg);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }

      // ─── Client-side date & rate validation (mirrors backend Pydantic validators) ───
      const today = dayjs().startOf('day');
      const dateErrors = [];
      validItems.forEach((item, idx) => {
        const label = item.item_name || item.item_code || `Row ${idx + 1}`;
        const mfg = item.manufacturing_date ? dayjs(item.manufacturing_date) : null;
        const exp = item.expiry_date ? dayjs(item.expiry_date) : null;
        const rate = item.rate ?? 0;

        if (rate < 0) {
          dateErrors.push(`"${label}": Rate cannot be negative`);
        }
        if (exp && exp.isBefore(today)) {
          const dateLabel = item.item_type === 'asset' ? 'Warranty end date' : 'Expiry date';
          dateErrors.push(`"${label}": ${dateLabel} (${exp.format('DD-MM-YYYY')}) cannot be in the past`);
        }
        if (mfg && mfg.isAfter(today.add(1, 'day'))) {
          dateErrors.push(`"${label}": Manufacturing date (${mfg.format('DD-MM-YYYY')}) cannot be more than 1 day in the future`);
        }
        if (mfg && exp && mfg.isAfter(exp)) {
          const expLabel = item.item_type === 'asset' ? 'warranty end date' : 'expiry date';
          dateErrors.push(`"${label}": Manufacturing date must be before ${expLabel}`);
        }
      });
      if (dateErrors.length > 0) {
        setErrorAlert(dateErrors.join('\n'));
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      // ──────────────────────────────────────────────────────────────────────────────

      setSubmitting(true);

      const payload = {
        po_id: selectedPO?.id || values.po_id || null,
        inward_id: selectedInward?.id || values.inward_id || null,
        po_number: selectedPO?.po_number || selectedInward?.po_number || grn?.po_number || values.po_number || null,
        vendor_id: values.vendor_id,
        warehouse_id: values.warehouse_id,
        grn_date: formatDateForAPI(values.grn_date),
        supplier_invoice: values.supplier_invoice || null,
        supplier_invoice_date: formatDateForAPI(values.supplier_invoice_date) || null,
        vehicle_number: values.vehicle_number || null,
        lr_number: values.lr_number || null,
        receipt_type: receiptType,
        remarks: values.remarks || null,
        items: validItems.map((item) => ({
          item_id: item.item_id,
          po_item_id: item.po_item_id || null,
          ordered_qty: Number(item.ordered_qty) || 0,
          received_qty: Number(item.received_qty) || 0,
          accepted_qty: Number(item.accepted_qty) || Number(item.received_qty) || 0,
          rejected_qty: Number(item.rejected_qty) || 0,
          damaged_qty: Number(item.damaged_qty) || 0,
          uom_id: item.uom_id,
          batch_number: item.batch_number && item.batch_number.trim() ? item.batch_number.trim() : null,
          manufacturing_date: item.manufacturing_date ? formatDateForAPI(item.manufacturing_date) : null,
          expiry_date: item.expiry_date ? formatDateForAPI(item.expiry_date) : null,
          rate: Number(item.rate) || 0,
          remarks: item.remarks || null,
        })),
      };

      if (isNew) {
        // Debug: log the payload being sent
        console.log('[GRNForm] Submitting payload:', JSON.stringify(payload, null, 2));
        const res = await api.post('/warehouse/grn', payload);
        message.success('GRN created successfully');
        const newId = res.data.id || res.data.data?.id;
        if (newId) {
          navigate(`/warehouse/grn/${newId}`);
        } else {
          navigate('/warehouse/grn');
        }
      } else {
        console.log('[GRNForm] Updating payload:', JSON.stringify(payload, null, 2));
        await api.put(`/warehouse/grn/${id}`, payload);
        message.success('GRN updated successfully');
        setEditMode(false);
        fetchGRN();
      }
    } catch (err) {
      if (err.errorFields) return;
      // Log full error for debugging
      if (err?.response) {
        console.error('[GRNForm] API error:', err.response.status, JSON.stringify(err.response.data, null, 2));
      }
      const errMsg = getErrorMessage(err);
      setErrorAlert(errMsg);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setSubmitting(false);
    }
  };

  // --- Actions on existing GRN ---
  const handleSubmitForQI = async () => {
    try {
      await api.put(`/warehouse/grn/${id}/submit-qi`);
      message.success('GRN submitted for Quality Inspection');
      fetchGRN();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleComplete = async () => {
    try {
      await api.put(`/warehouse/grn/${id}/complete`);
      message.success('GRN completed');
      fetchGRN();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleDelete = async () => {
    try {
      await api.delete(`/warehouse/grn/${id}`);
      message.success('GRN deleted');
      navigate('/warehouse/grn');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Loading state ---
  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}>
        <Spin size="large" />
      </div>
    );
  }

  // ============================
  // VIEW MODE (existing GRN)
  // ============================
  if (!isNew && grn && !editMode) {
    const grnItemsList = grn.items || [];
    const hasAssetInView = grnItemsList.some(r => r.item_type === 'asset' || (r.item && r.item.item_type === 'asset'));
    const statusIdx = GRN_STATUS_FLOW.indexOf(grn.status);
    const typeMap = { inward_based: 'Inward Based', po_based: 'PO Based', direct: 'Direct', transfer: 'Transfer', return: 'Return' };

    return (
      <div>
        <PageHeader title={grn.grn_number || `GRN #${id}`} subtitle="Goods Receipt Note Detail">
          <Space>
            {grn.status === 'draft' && (
              <>
                <Button icon={<EditOutlined />} onClick={() => { setEditMode(true); loadLookups(); loadPOOptions(); }}>
                  Edit
                </Button>
                <Popconfirm title="Submit this GRN for Quality Inspection?" onConfirm={handleSubmitForQI}>
                  <Button type="primary" icon={<ExperimentOutlined />}>Submit for QI</Button>
                </Popconfirm>
                <Popconfirm title="Delete this GRN?" onConfirm={handleDelete} okButtonProps={{ danger: true }}>
                  <Button danger icon={<CloseCircleOutlined />}>Delete</Button>
                </Popconfirm>
              </>
            )}
            {grn.status === 'pending_qi' && (
              <Popconfirm title="Mark GRN as completed?" onConfirm={handleComplete}>
                <Button type="primary" icon={<CheckOutlined />}>Complete</Button>
              </Popconfirm>
            )}
            <Button icon={<PrinterOutlined />} onClick={handlePrint}>Print</Button>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/warehouse/grn')}>Back</Button>
          </Space>
        </PageHeader>

        <div style={{ display: 'none' }}>
          <PurchaseReceiptPrint ref={printRef} data={grn} />
        </div>

        {/* Status Flow */}
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {GRN_STATUS_FLOW.map((s, idx) => {
              const isCurrent = s === grn.status;
              const isPast = idx < statusIdx;
              return (
                <Tag
                  key={s}
                  color={grn.status === 'cancelled' ? 'default' : isCurrent ? 'blue' : isPast ? 'green' : 'default'}
                  style={{ padding: '4px 12px', fontSize: 13 }}
                >
                  {s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </Tag>
              );
            })}
            {grn.status === 'cancelled' && (
              <Tag color="red" style={{ padding: '4px 12px', fontSize: 13 }}>Cancelled</Tag>
            )}
          </div>
        </Card>

        <Card title="Goods Receipt Note Details" style={{ marginBottom: 16 }} styles={{ body: { padding: '24px 24px 12px 24px' } }}>
          <Row gutter={[24, 16]}>
            <Col xs={12} sm={8} md={6}>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>GRN Number</Text>
              <Text strong style={{ fontSize: 14 }}>{grn.grn_number || '-'}</Text>
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>GRN Date</Text>
              <Text style={{ fontSize: 14 }}>{formatDate(grn.grn_date) || '-'}</Text>
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Status</Text>
              <div style={{ marginTop: 2 }}><StatusTag status={grn.status} /></div>
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Receipt Type</Text>
              <div style={{ marginTop: 2 }}>
                <Tag color="blue">{typeMap[grn.receipt_type] || grn.receipt_type || '-'}</Tag>
              </div>
            </Col>

            <Col xs={12} sm={8} md={6}>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Vendor</Text>
              <Text style={{ fontSize: 14 }}>{grn.vendor_name || '-'}</Text>
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Warehouse</Text>
              <Text style={{ fontSize: 14 }}>{grn.warehouse_name || '-'}</Text>
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>PO Reference</Text>
              <Text style={{ fontSize: 14 }}>{grn.po_number || '-'}</Text>
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Inward Reference</Text>
              <Text style={{ fontSize: 14 }}>{grn.inward_number || '-'}</Text>
            </Col>

            <Col xs={12} sm={8} md={6}>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Supplier Invoice</Text>
              <Text style={{ fontSize: 14 }}>{grn.supplier_invoice || '-'}</Text>
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Supplier Invoice Date</Text>
              <Text style={{ fontSize: 14 }}>{formatDate(grn.supplier_invoice_date) || '-'}</Text>
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Vehicle Number</Text>
              <Text style={{ fontSize: 14 }}>{grn.vehicle_number || '-'}</Text>
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>LR Number</Text>
              <Text style={{ fontSize: 14 }}>{grn.lr_number || '-'}</Text>
            </Col>

            <Col xs={12} sm={8} md={6}>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Total Qty</Text>
              <Text strong style={{ fontSize: 14 }}>{formatNumber(grn.total_qty) || '0'}</Text>
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Total Amount</Text>
              <Text strong style={{ fontSize: 14, color: '#eb2f96' }}>{formatCurrency(grn.total_amount) || '0.00'}</Text>
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Received By</Text>
              <Text style={{ fontSize: 14 }}>{grn.received_by_name || grn.received_by || '-'}</Text>
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Created At</Text>
              <Text style={{ fontSize: 14 }}>{formatDateTime(grn.created_at) || '-'}</Text>
            </Col>

            <Col span={24}>
              <Divider style={{ margin: '8px 0 12px 0' }} />
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Remarks</Text>
              <Text style={{ fontSize: 14, display: 'block', fontStyle: grn.remarks ? 'normal' : 'italic' }}>
                {grn.remarks || 'No remarks provided.'}
              </Text>
            </Col>
          </Row>
        </Card>

        <Card>
          <Divider orientation="left">
            <Space>
              Items
              <Badge count={grnItemsList.length} style={{ backgroundColor: '#eb2f96' }} />
            </Space>
          </Divider>
          <Table
            dataSource={grnItemsList}
            rowKey={(r) => r.id || r.item_id}
            size="small"
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
              {
                title: 'Item Code', width: 120,
                render: (_, r) => r.item_code || (r.item && r.item.item_code) || '-',
              },
              {
                title: 'Item Name', width: 220,
                render: (_, r) => r.item_name || (r.item && (r.item.item_name || r.item.name)) || '-',
              },
              { title: 'UOM', dataIndex: 'uom', width: 80, render: (v) => v || '-' },
              { title: 'Ordered Qty', dataIndex: 'ordered_qty', width: 100, align: 'right', render: (v) => formatNumber(v || 0) },
              { title: 'Received Qty', dataIndex: 'received_qty', width: 110, align: 'right', render: (v) => <Text strong>{formatNumber(v || 0)}</Text> },
              { title: 'Batch No', dataIndex: 'batch_number', width: 100, render: (v) => v || '-' },
              { title: 'Expiry / Warranty End Date', dataIndex: 'expiry_date', width: 110, render: (v, r) => {
                if (!v) return '-';
                const isAsset = r.item_type === 'asset' || (r.item && r.item.item_type === 'asset');
                const label = isAsset ? 'Warranty: ' : 'Exp: ';
                return (
                  <Tooltip title={isAsset ? 'Warranty End Date' : 'Expiry Date'}>
                    <span>{label}{formatDate(v)}</span>
                  </Tooltip>
                );
              } },
              { title: 'Rate', dataIndex: 'rate', width: 100, align: 'right', render: (v) => formatCurrency(v) },
              { title: 'Amount', dataIndex: 'amount', width: 120, align: 'right', render: (v) => <Text strong>{formatCurrency(v)}</Text> },
              { title: 'Remarks', dataIndex: 'remarks', width: 150, ellipsis: true, render: (v) => v || '-' },
              {
                title: 'Serial Numbers',
                dataIndex: 'serial_numbers',
                width: 200,
                render: (v, r) => {
                  if (!r.has_serial) return <Text type="secondary">-</Text>;
                  const sns = Array.isArray(v) ? v.filter(Boolean) : [];
                  if (sns.length === 0) return <Text type="danger">None recorded</Text>;
                  return (
                    <div>
                      {sns.map((sn, i) => (
                        <div key={i} style={{ fontSize: 12 }}>
                          <Text type="secondary">{i + 1}.</Text> <Tag style={{ marginBottom: 2 }}>{sn}</Tag>
                        </div>
                      ))}
                    </div>
                  );
                },
              },
            ]}
            summary={() => (
              <Table.Summary>
                <Table.Summary.Row>
                  <Table.Summary.Cell colSpan={5} align="right"><Text strong>Totals:</Text></Table.Summary.Cell>
                  <Table.Summary.Cell align="right">
                    <Text strong>{formatNumber(grnItemsList.reduce((s, i) => s + (i.received_qty || 0), 0))}</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell colSpan={3} />
                  <Table.Summary.Cell align="right">
                    <Text strong style={{ color: '#eb2f96' }}>
                      {formatCurrency(grnItemsList.reduce((s, i) => s + (i.amount || 0), 0))}
                    </Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell />
                </Table.Summary.Row>
              </Table.Summary>
            )}
          />
        </Card>
      </div>
    );
  }

  // ============================
  // CREATE / EDIT MODE
  // ============================
  const hasAnySerial = grnItems.some(i => i.has_serial);

  const itemColumns = [
    { title: '#', width: 35, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item', dataIndex: 'item_id', width: 220,
      render: (val, record) =>
        record.po_item_id && record.item_name ? (
          <Tooltip title={record.item_name}>
            <Text ellipsis style={{ maxWidth: 200 }}>{record.item_name}</Text>
          </Tooltip>
        ) : (
          <ItemSelector
            value={val}
            onChange={async (itemId, item) => {
              if (!itemId) {
                mergeItemRow(record.key, {
                  item_id: null, item_name: '', item_code: '',
                  uom_id: null, uom: '', rate: 0, amount: 0,
                  item_type: null, serial_numbers: [],
                });
                return;
              }
              // Start with what ItemSelector gave us
              let itemType = item?.item_type || null;
              // If item_type is missing (shouldn't happen, but defensive), fetch it
              if (!itemType && itemId) {
                try {
                  const r = await api.get(`/masters/items/${itemId}`);
                  itemType = r.data?.item_type || null;
                } catch { /* silent */ }
              }
              mergeItemRow(record.key, {
                item_id: itemId,
                item_name: item?.item_name || item?.name || '',
                item_code: item?.item_code || item?.code || '',
                uom_id: item?.primary_uom_id || null,
                uom: item?.primary_uom?.name || item?.primary_uom_name || item?.uom || '',
                rate: item?.last_purchase_rate || item?.rate || 0,
                item_type: itemType,
                has_serial: !!(item?.has_serial),
                serial_numbers: [],
              });
            }}
            style={{ width: '100%' }}
          />
        ),
    },
    {
      title: 'Ordered', dataIndex: 'ordered_qty', width: 75, align: 'center',
      render: (val) => <Text type="secondary">{formatNumber(val || 0)}</Text>,
    },
    {
      title: 'Received Qty', dataIndex: 'received_qty', width: 95,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateItemRow(record.key, 'received_qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'Accepted', dataIndex: 'accepted_qty', width: 85,
      render: (val, record) => (
        <InputNumber
          min={0} max={record.received_qty || 999999}
          value={val}
          onChange={(v) => updateItemRow(record.key, 'accepted_qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'Rejected', dataIndex: 'rejected_qty', width: 85,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateItemRow(record.key, 'rejected_qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'Damaged', dataIndex: 'damaged_qty', width: 85,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateItemRow(record.key, 'damaged_qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'UOM', dataIndex: 'uom_id', width: 130,
      render: (val, record) => (
        <Select
          value={val}
          onChange={(v) => updateItemRow(record.key, 'uom_id', v)}
          options={uoms}
          placeholder="UOM"
          showSearch
          optionFilterProp="label"
          allowClear
          size="small"
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: <span>Batch No <span style={{ color: '#ff4d4f' }}>*</span></span>,
      dataIndex: 'batch_number',
      width: 100,
      render: (val, record) => (
        <Input
          value={val}
          onChange={(e) => updateItemRow(record.key, 'batch_number', e.target.value)}
          size="small"
          placeholder="Batch"
        />
      ),
    },
    {
      title: 'Mfg Date', dataIndex: 'manufacturing_date', width: 120,
      render: (val, record) => (
        <DatePicker
          value={val ? dayjs(val) : null}
          onChange={(d) => updateItemRow(record.key, 'manufacturing_date', d)}
          size="small"
          format={DATE_FORMAT}
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Expiry / Warranty End Date',
      dataIndex: 'expiry_date',
      width: 120,
      render: (val, record) => (
        <DatePicker
          value={val ? dayjs(val) : null}
          onChange={(d) => updateItemRow(record.key, 'expiry_date', d)}
          size="small"
          format={DATE_FORMAT}
          placeholder={record.item_type === 'asset' ? 'Warranty End' : 'Expiry Date'}
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Rate', dataIndex: 'rate', width: 90,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateItemRow(record.key, 'rate', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'Amount', dataIndex: 'amount', width: 100, align: 'right',
      render: (val) => <Text strong style={{ fontSize: 12 }}>{formatCurrency(val)}</Text>,
    },
    {
      title: 'Remarks', dataIndex: 'remarks', width: 130,
      render: (val, record) => (
        <Input
          value={val}
          onChange={(e) => updateItemRow(record.key, 'remarks', e.target.value)}
          size="small"
          placeholder="Remarks"
        />
      ),
    },
    {
      title: '', width: 35,
      render: (_, record) =>
        grnItems.length > 1 ? (
          <Tooltip title="Remove">
            <MinusCircleOutlined
              style={{ color: '#ff4d4f', cursor: 'pointer', fontSize: 16 }}
              onClick={() => removeItemRow(record.key)}
            />
          </Tooltip>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title={isNew ? 'Create GRN' : `Edit ${grn?.grn_number || ''}`}
        subtitle={isNew ? 'Create a new Goods Receipt Note' : 'Edit goods receipt note'}
      >
        <Space>
          <Button onClick={() => navigate('/warehouse/grn')} icon={<ArrowLeftOutlined />}>Back</Button>
          {!isNew && <Button onClick={() => setEditMode(false)}>Cancel Edit</Button>}
        </Space>
      </PageHeader>

      {errorAlert && (
        <div style={{
          position: 'sticky',
          top: 16,
          zIndex: 1000,
          marginBottom: 16,
          boxShadow: '0 4px 12px rgba(255, 77, 79, 0.15)',
          borderRadius: '8px'
        }}>
          <Alert
            message="Validation Error — Please fix the following before saving"
            description={
              typeof errorAlert === 'string' && errorAlert.includes('\n')
                ? (
                  <ul style={{ margin: '4px 0 0 0', paddingLeft: 20 }}>
                    {errorAlert.split('\n').map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                )
                : errorAlert
            }
            type="error"
            showIcon
            closable
            onClose={() => setErrorAlert(null)}
          />
        </div>
      )}

      <Card>
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} sm={8}>
              <Form.Item name="receipt_type" label="Receipt Type" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  options={RECEIPT_TYPES}
                  placeholder="Select receipt type"
                  onChange={handleReceiptTypeChange}
                />
              </Form.Item>
            </Col>
            {receiptType === 'inward_based' && (
              <Col xs={24} sm={8}>
                <Form.Item name="inward_id" label="Material Inward" rules={[{ required: true, message: 'Select a Material Inward' }]}>
                  <Select
                    options={inwardOptions}
                    placeholder="Search and select Material Inward..."
                    showSearch
                    optionFilterProp="label"
                    allowClear
                    onChange={handleInwardSelect}
                    onSearch={(v) => loadInwardOptions(v)}
                    loading={loadingInwards}
                  />
                </Form.Item>
              </Col>
            )}
            {receiptType === 'inward_based' && (
              <Col xs={24} sm={4}>
                <Form.Item name="po_number" label="PO Number">
                  <Input disabled placeholder="Auto from Inward" />
                </Form.Item>
              </Col>
            )}
            <Col xs={24} sm={receiptType === 'inward_based' ? 4 : 8}>
              <Form.Item name="grn_date" label="GRN Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
          </Row>

          {/* PO Summary */}
          {selectedPO && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={
                <Text>
                  PO: <Text strong>{selectedPO.po_number}</Text> | Vendor: <Text strong>{selectedPO.vendor_name || '-'}</Text> |
                  Items: {(selectedPO.items || []).length} | Total: {formatCurrency(selectedPO.grand_total)}
                </Text>
              }
            />
          )}

          <Row gutter={16}>
            <Col xs={24} sm={8}>
              <Form.Item name="vendor_id" label="Vendor" rules={[{ required: true, message: 'Vendor is required' }]}>
                <Select
                  options={vendors}
                  placeholder="Select vendor"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item name="warehouse_id" label="Warehouse" rules={[{ required: true, message: 'Warehouse is required' }]}>
                <Select
                  options={warehouses}
                  placeholder="Select warehouse"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item name="supplier_invoice" label="Supplier Invoice No">
                <Input placeholder="Supplier invoice number" />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col xs={24} sm={8}>
              <Form.Item name="supplier_invoice_date" label="Supplier Invoice Date">
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item name="vehicle_number" label="Vehicle Number">
                <Input placeholder="Vehicle number" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item name="lr_number" label="LR Number">
                <Input placeholder="Lorry receipt number" />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item name="remarks" label="Remarks">
            <TextArea rows={2} placeholder="Any remarks..." />
          </Form.Item>
        </Form>

        <Divider orientation="left">
          <Space>
            Items
            <Badge count={grnItems.filter((i) => i.item_id).length} style={{ backgroundColor: '#eb2f96' }} />
          </Space>
        </Divider>

        <Table
          dataSource={grnItems}
          columns={itemColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 1400 }}
          loading={loadingPO}
          footer={() => (
            <Button type="dashed" onClick={addItemRow} icon={<PlusOutlined />} block>
              Add Item
            </Button>
          )}
        />

        {/* Totals */}
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ width: 300 }}>
            <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Col span={14}><Text>Total Received Qty:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}>
                <Text strong>{formatNumber(calcTotalQty())}</Text>
              </Col>
            </Row>
            <Row style={{ padding: '8px 0', background: '#fafafa', borderRadius: 4, marginTop: 4 }}>
              <Col span={14}><Text strong style={{ fontSize: 15 }}>Total Amount:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}>
                <Text strong style={{ fontSize: 15, color: '#eb2f96' }}>{formatCurrency(calcTotalAmount())}</Text>
              </Col>
            </Row>
          </div>
        </div>

        <Divider />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={() => navigate('/warehouse/grn')}>Cancel</Button>
          <Button icon={<SaveOutlined />} onClick={() => handleSubmit('draft')} loading={submitting}>
            Save as Draft
          </Button>
          <Button type="primary" icon={<SendOutlined />} onClick={() => handleSubmit('submit_qi')} loading={submitting}>
            Save &amp; Submit for QI
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default GRNForm;
